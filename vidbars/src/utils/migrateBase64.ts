/**
 * One-time migration: find all base64 data URLs in stores,
 * upload them to the server, and replace with server URLs.
 * Shrinks localStorage from ~100MB to <1MB.
 */
import { useFreeNodeStore } from '../store/freeNodeStore'
import { useBoardsStore } from '../store/boardsStore'

const MIGRATION_KEY = 'vidbars-base64-migrated'

function dataUrlToFile(dataUrl: string, name: string): File {
  const [header, b64] = dataUrl.split(',')
  const mime = header.match(/:(.*?);/)?.[1] ?? 'image/png'
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new File([bytes], name, { type: mime })
}

async function uploadBase64(dataUrl: string, name: string): Promise<string | null> {
  try {
    const file = dataUrlToFile(dataUrl, name)
    const form = new FormData()
    form.append('file', file)
    const res = await fetch('/api/upload', { method: 'POST', body: form })
    if (!res.ok) return null
    const data = await res.json()
    return data.url
  } catch {
    return null
  }
}

export async function migrateBase64ToServer(): Promise<void> {
  // Skip if already migrated
  if (localStorage.getItem(MIGRATION_KEY)) return

  console.log('[migrate] Scanning for base64 data URLs...')
  let count = 0

  // ── Migrate free nodes ──
  const freeState = useFreeNodeStore.getState()
  const nodes = { ...freeState.nodes }
  for (const [id, node] of Object.entries(nodes)) {
    if (node.imageUrl?.startsWith('data:')) {
      const url = await uploadBase64(node.imageUrl, `freenode-${id}.png`)
      if (url) {
        useFreeNodeStore.getState().updateFreeNode(id, { imageUrl: url })
        count++
        console.log(`[migrate] FreeNode ${id} image → ${url}`)
      }
    }
  }

  // ── Migrate boards ──
  const boardsState = useBoardsStore.getState()
  for (const [boardId, board] of Object.entries(boardsState.boards)) {
    for (const [barId, bar] of Object.entries(board.bars)) {
      // Bar icon
      if (bar.icon?.startsWith('data:')) {
        const url = await uploadBase64(bar.icon, `bar-icon-${barId}.png`)
        if (url) {
          useBoardsStore.getState().setIcon(boardId, barId, url)
          count++
          console.log(`[migrate] Bar ${barId} icon → ${url}`)
        }
      }

      // Legacy images[]
      const images = bar.content?.images ?? []
      const newImages: string[] = []
      let imagesChanged = false
      for (let i = 0; i < images.length; i++) {
        if (images[i].startsWith('data:')) {
          const url = await uploadBase64(images[i], `bar-img-${barId}-${i}.png`)
          if (url) {
            newImages.push(url)
            imagesChanged = true
            count++
            console.log(`[migrate] Bar ${barId} images[${i}] → ${url}`)
          } else {
            newImages.push(images[i]) // keep original on failure
          }
        } else {
          newImages.push(images[i])
        }
      }
      if (imagesChanged) {
        useBoardsStore.getState().setContent(boardId, barId, { images: newImages })
      }

      // New media[]
      const media = bar.content?.media ?? []
      const newMedia = [...media]
      let mediaChanged = false
      for (let i = 0; i < media.length; i++) {
        if (media[i].url?.startsWith('data:')) {
          const url = await uploadBase64(media[i].url, `bar-media-${barId}-${i}.png`)
          if (url) {
            newMedia[i] = { ...media[i], url }
            mediaChanged = true
            count++
            console.log(`[migrate] Bar ${barId} media[${i}] → ${url}`)
          }
        }
      }
      if (mediaChanged) {
        useBoardsStore.getState().setContent(boardId, barId, { media: newMedia })
      }
    }
  }

  if (count > 0) {
    console.log(`[migrate] Migrated ${count} base64 URLs to server. localStorage will shrink on next persist.`)
  } else {
    console.log('[migrate] No base64 data URLs found.')
  }

  localStorage.setItem(MIGRATION_KEY, Date.now().toString())
}
