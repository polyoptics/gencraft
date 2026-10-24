// useVideoPosterBackfill — give every video on a bar a poster frame.
//
// A video on a bar is only ever SEEN through its MediaItem.posterUrl: bar
// heroes, block thumbnails, card heroes, the Card Browser and the Viewer
// strip all draw pictures, and getFirstImageUrl() offers a video to them
// only by its poster. Every way a video reaches a bar — an Explorer drop,
// the Media Pool, the bar's file picker, an imported project — used to leave
// that field empty, so the bar showed nothing.
//
// Rather than patch each of those paths, this fills the gap in one place:
// ask thumbService for a frame of each poster-less video (filed in the
// shared poster map under the video's stored url), and write it onto the
// item when it lands. Mounted once, in App.

import { useEffect, useRef } from 'react'
import { useBoardsStore } from '../store/boardsStore'
import { usePosterMapStore } from '../three/posterService'
import { requestThumb } from '../utils/thumbService'
import { resolveMediaUrl } from '../utils/useResolvedMedia'

export function useVideoPosterBackfill(): void {
  const boards = useBoardsStore(s => s.boards)
  const posters = usePosterMapStore(s => s.map)
  /** Asked once per url per session: this runs on every board change
   *  (every drag frame), and a file that cannot be read must not be
   *  re-queued forever. */
  const asked = useRef(new Set<string>())

  useEffect(() => {
    for (const board of Object.values(boards)) {
      for (const bar of Object.values(board.bars)) {
        const media = bar.content?.media
        if (!media?.some(m => m.type === 'video' && !m.posterUrl)) continue

        // Fill whatever has landed, in one write per bar.
        let changed = false
        const next = media.map(m => {
          if (m.type !== 'video' || m.posterUrl || !posters[m.url]) return m
          changed = true
          return { ...m, posterUrl: posters[m.url] }
        })
        if (changed) useBoardsStore.getState().setContent(board.id, bar.id, { media: next })

        // Ask for the rest. A `mediaref:` video streams through its object
        // url, but the frame is filed under the stored ref.
        for (const m of next) {
          if (m.type !== 'video' || m.posterUrl || asked.current.has(m.url)) continue
          asked.current.add(m.url)
          void resolveMediaUrl(m.url).then(src => {
            if (src) requestThumb(m.url, 'video', true, src)
          })
        }
      }
    }
  }, [boards, posters])
}
