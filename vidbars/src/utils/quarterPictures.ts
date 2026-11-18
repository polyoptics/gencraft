// quarterPictures.ts — what is drawn of a model, drawn again when the
// model is squared up another way (three/modelQuarter: quarter turns and
// a mirror, kept with its file). The 3D view swaps its own copies
// (tiltScene); here the rest follow, so the flat view shows what the 3D
// view does: the model's poster (tiles, the browser), the poster a card's
// block keeps for its face, its pieces in a 3D set seen from above, and
// the Viewers it is showing in.

import { onQuarterChange } from '../three/modelQuarter'
import { redrawModelPoster } from '../three/posterService'
import { dropPieces } from '../three/pieceService'
import { redrawModelViews } from '../three/viewportRenderer'
import { useBoardsStore } from '../store/boardsStore'
import { useModelScaleStore } from '../store/tiltStore'

/** Give every block showing model `url` its new poster (a card's face
 *  shows the one its block keeps). One a thumbnail was picked for by hand
 *  keeps it. */
function repaintBlocks(url: string, poster: string) {
  const bs = useBoardsStore.getState()
  for (const [boardId, board] of Object.entries(bs.boards)) {
    for (const [barId, bar] of Object.entries(board.bars)) {
      const items = bar.content?.media
      if (!items?.some(m => m.type === 'model' && m.url === url && m.posterUrl && m.posterUrl !== poster && !m.posterOriginal)) continue
      bs.setContent(boardId, barId, { media: items.map(m => m.type === 'model' && m.url === url && m.posterUrl && !m.posterOriginal ? { ...m, posterUrl: poster } : m) })
    }
  }
}

let started = false
export function startQuarterPictures(): void {
  if (started) return
  started = true
  onQuarterChange((url, fresh) => {
    redrawModelViews(url)
    // Read back as it was kept (a reload): the pictures kept are of it so.
    if (!fresh) return
    dropPieces(url)
    const was = useModelScaleStore.getState().quarterOf[url]
    void redrawModelPoster(url).then(poster => {
      // (Changed again meanwhile: the later picture is on its way.)
      if (poster && useModelScaleStore.getState().quarterOf[url] === was) repaintBlocks(url, poster)
    })
  })
}
