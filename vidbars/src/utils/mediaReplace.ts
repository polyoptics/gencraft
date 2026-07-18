// mediaReplace.ts — rewrite every occurrence of a media url across the
// stores. Used by the Viewer's image editor: a crop/paint bake produces a
// NEW blob, and since BrowseItems carry no provenance, the honest way to
// "save" is to update the url everywhere it appears (tiles, bar media,
// bar icons, block thumbnails, card heroes). The old blob stays in the
// media store (undo restores the old urls; GC reclaims later).

import { useBoardsStore } from '../store/boardsStore'
import { useFreeNodeStore } from '../store/freeNodeStore'

/** Replace `oldUrl` with `newUrl` wherever it appears. Returns the number
 *  of fields rewritten. Caller is responsible for checkpoint(). */
export function replaceMediaUrl(oldUrl: string, newUrl: string): number {
  let count = 0

  // ── Free nodes: imageUrl / posterUrl ──
  const fns = useFreeNodeStore.getState()
  for (const n of Object.values(fns.nodes)) {
    const patch: { imageUrl?: string; posterUrl?: string } = {}
    if (n.imageUrl === oldUrl) { patch.imageUrl = newUrl; count++ }
    if (n.posterUrl === oldUrl) { patch.posterUrl = newUrl; count++ }
    if (Object.keys(patch).length > 0) fns.updateFreeNode(n.id, patch)
  }

  // ── Boards: bar media urls/posters, icons, legacy images, layer images;
  //    groups: card heroes. One setState for the whole sweep. ──
  useBoardsStore.setState(s => {
    let boardsChanged = false
    const boards = { ...s.boards }
    for (const [bid, board] of Object.entries(boards)) {
      let barsChanged = false
      const bars = { ...board.bars }
      for (const [barId, bar] of Object.entries(bars)) {
        let barChanged = false
        let icon = bar.icon
        if (icon === oldUrl) { icon = newUrl; barChanged = true; count++ }
        let content = bar.content
        if (content) {
          const images = content.images?.map(u => {
            if (u === oldUrl) { count++; return newUrl }
            return u
          })
          const media = content.media?.map(m => {
            const url = m.url === oldUrl ? (count++, newUrl) : m.url
            const posterUrl = m.posterUrl === oldUrl ? (count++, newUrl) : m.posterUrl
            return url !== m.url || posterUrl !== m.posterUrl ? { ...m, url, posterUrl } : m
          })
          const imagesChanged = !!images && images.some((u, i) => u !== content!.images[i])
          const mediaChanged = !!media && media.some((m, i) => m !== content!.media[i])
          if (imagesChanged || mediaChanged) {
            content = { ...content, images: images ?? content.images, media: media ?? content.media }
            barChanged = true
          }
        }
        if (barChanged) { bars[barId] = { ...bar, icon, content }; barsChanged = true }
      }
      let layers = board.layers
      let layersChanged = false
      if (layers?.card?.heroImage === oldUrl) {
        layers = { ...layers, card: { ...layers.card, heroImage: newUrl } }
        layersChanged = true; count++
      }
      if (layers?.block?.thumbnail === oldUrl) {
        layers = { ...layers, block: { ...layers!.block, thumbnail: newUrl } }
        layersChanged = true; count++
      }
      if (barsChanged || layersChanged) {
        boards[bid] = { ...board, bars: barsChanged ? bars : board.bars, layers }
        boardsChanged = true
      }
    }
    let groupsChanged = false
    const groups = s.groups.map(g => {
      if (g.cardHeroImage === oldUrl) { groupsChanged = true; count++; return { ...g, cardHeroImage: newUrl } }
      return g
    })
    if (!boardsChanged && !groupsChanged) return s
    return {
      ...(boardsChanged ? { boards } : {}),
      ...(groupsChanged ? { groups } : {}),
    }
  })

  return count
}
