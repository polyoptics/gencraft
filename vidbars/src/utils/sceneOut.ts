// What a scene card's section hands over when it is dragged out of the app
// (Brian 2026-11-16: "the little drag-out icon for the sections"; then, of
// a section with an animated GIF that had none: "I'm going to ask for a
// lift out on any media type there").
//
// A section shows a picture, but what it stands for is its card's media: a
// movie (the section draws its poster), a sound, a 3D model, a picture. So
// the file handed over is that media's own, whatever its kind.
//
// Media dropped in from a web page or pasted is kept INSIDE the project
// (mediaref:, data:), with no file on disk to hand over. A picture or GIF
// kept that way is written out first, to the app's Drag Cache (as an effect
// result is, components/Canvas/FxResultLayer), and that copy is dragged.
// A movie, sound or 3D model kept that way is written out too, its bytes as
// they are (the desktop side's saveDragMedia; a desktop side from before it
// has nothing to give for those until the app is restarted).

import { useEffect, useState } from 'react'
import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { getMediaItems } from '../types/bar'
import { mayHaveDiskFile } from '../hooks/useFileMenu'
import { cardFaceAudio, cardFaceSourceUrl } from './cardGrid'
import { diskFileUrl } from './diskUrl'
import { blobToDataUrl, isDataUrl, isMediaRef } from './mediaRef'
import { groupFaceSource } from './mediaSources'
import { resolveMediaUrl } from './useResolvedMedia'

/** The file name a stored url of this card was brought in under, if known. */
function nameOf(url: string, card: ProjectGroup | undefined): string | undefined {
  const boards = useBoardsStore.getState().boards
  for (const bid of card?.boardIds ?? []) {
    const b = boards[bid]
    for (const rid of b?.rootIds ?? []) {
      const m = getMediaItems(b.bars[rid]?.content).find(x => x.url === url)
      if (m?.originalName) return m.originalName
    }
  }
  return undefined
}

/** The stored urls a section could hand over, best first: its card's face
 *  (the movie or model itself, not its poster), its sound, the section's
 *  own picture, then anything else its card holds. */
export function sectionOutSources(image: string | null, card: ProjectGroup | undefined): string[] {
  const boards = useBoardsStore.getState().boards
  const out: string[] = []
  const add = (u: string | null | undefined) => { if (u && !out.includes(u)) out.push(u) }
  if (card) {
    add(cardFaceSourceUrl(card, boards))
    add(cardFaceAudio(card, boards)?.url)
    add(groupFaceSource(card, boards))
  }
  add(image)
  if (card) {
    for (const bid of card.boardIds) {
      const b = boards[bid]
      for (const rid of b?.rootIds ?? []) for (const m of getMediaItems(b.bars[rid]?.content)) add(m.url)
    }
  }
  return out
}

// Copies written to the Drag Cache this session: stored value -> its file's
// url. The cache is held to a budget on the desktop side (the oldest go),
// so a copy is trusted only for a while and then written again.
const COPY_TTL_MS = 20 * 60_000
const copies = new Map<string, { at: number; url: Promise<string | null> }>()

/** The kinds the desktop side writes as they are, by what the browser calls
 *  them; a file's own ending decides when that says nothing (a model). */
const EXT_OF: Record<string, string> = {
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'video/x-m4v': 'm4v', 'video/x-matroska': 'mkv', 'video/ogg': 'ogv',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
  'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'model/gltf-binary': 'glb',
}
const RAW_EXT = /^(mp4|webm|mov|m4v|mkv|ogv|mp3|wav|ogg|oga|opus|m4a|aac|flac|glb|fbx|obj)$/

async function writeCopy(held: string, name: string, fileName: string | undefined): Promise<string | null> {
  const d = window.vidbarsDesktop
  if (!d?.saveImage) return null
  try {
    const src = await resolveMediaUrl(held)
    if (!src) return null
    const blob = await (await fetch(src)).blob()
    if (!blob.type.startsWith('image/')) {
      // A movie, sound or model: its bytes as they are.
      if (typeof d.saveDragMedia !== 'function') return null
      const ending = /\.([a-z0-9]+)$/i.exec(fileName ?? '')?.[1]?.toLowerCase() ?? ''
      const ext = EXT_OF[blob.type.split(';')[0]] ?? (RAW_EXT.test(ending) ? ending : '')
      if (!ext) return null
      const stem = (fileName ?? '').replace(/\.[a-z0-9]+$/i, '') || name || 'media'
      const saved = await d.saveDragMedia(stem, ext, new Uint8Array(await blob.arrayBuffer()))
      return saved && 'path' in saved ? diskFileUrl(saved.path) : null
    }
    let dataUrl: string
    if (/^image\/(png|jpeg|gif)$/.test(blob.type)) dataUrl = await blobToDataUrl(blob)
    else if (blob.type.startsWith('image/')) {
      // Another kind of picture: as a PNG.
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bmp.width; c.height = bmp.height
      c.getContext('2d')!.drawImage(bmp, 0, 0)
      bmp.close()
      dataUrl = c.toDataURL('image/png')
    } else return null
    const saved = await d.saveImage('drag', name || 'image', dataUrl)
    const p = typeof saved === 'string' ? saved : saved && 'path' in saved ? saved.path : null
    return p ? diskFileUrl(p) : null
  } catch {
    return null
  }
}

function copyOf(held: string, name: string, fileName: string | undefined): Promise<string | null> {
  const known = copies.get(held)
  if (known && Date.now() - known.at < COPY_TTL_MS) return known.url
  const url = writeCopy(held, name, fileName)
  copies.set(held, { at: Date.now(), url })
  // A failure is tried again at the next hover.
  void url.then(u => { if (!u && copies.get(held)?.url === url) copies.delete(held) })
  return url
}

/** The url a section's drag-out grip carries. Worked out once the section
 *  is `wanted` (pointed at) and kept after, so a press on the grip outlasts
 *  the hover. Null: nothing to give (yet). */
export function useSectionOut(image: string | null, card: ProjectGroup | undefined, name: string, wanted: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!wanted) return
    const all = sectionOutSources(image, card)
    const file = all.find(u => mayHaveDiskFile(u))
    if (file) { setUrl(file); return }
    const held = all.find(u => isMediaRef(u) || isDataUrl(u))
    if (!held) { setUrl(null); return }
    let live = true
    void copyOf(held, name, nameOf(held, card)).then(u => { if (live) setUrl(u) })
    return () => { live = false }
  }, [wanted, image, card, name])
  return url
}
