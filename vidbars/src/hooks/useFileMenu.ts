// useFileMenu — "Show in Explorer / Copy path / Open" for the file on disk
// behind a piece of media. Desktop app only.
//
// Two ways in, one source of items:
//
//   useFileMenuItems(url, close)  — items in the { label, icon, action }
//     shape every existing context menu already builds (card, block, bar,
//     free node). Append them; an empty array means "nothing to add", which
//     is always the answer in a plain browser.
//
//   <FileContextMenu> (components/UI/FileMenu.tsx) — a small standalone
//     menu for media that sits inside something whose own menu is about
//     something else (a Media Pool tile, a Rolodex slot, the Viewer). Open
//     it only when mayHaveDiskFile(url).
//
// Pass the STORED url of the media itself — MediaItem.url, node.imageUrl —
// never the picture being shown: for video and models that is a poster.
// getFirstMediaSource() (types/bar.ts) is the card/block/bar helper.

import { useEffect, useState } from 'react'

export interface FileMenuItem {
  label: string
  icon: string
  action: () => void
  /** True on the first file item: hosts draw a divider above it. */
  separator?: boolean
}

export type ResolvedFile = { path: string; exists: boolean } | null

/** The bridge's resolver, if this window has one. Feature-detected per
 *  method: after a hot reload the app can be newer than the preload. */
function resolver() {
  const d = window.vidbarsDesktop
  return d && typeof d.resolveMedia === 'function' ? d : null
}

/** Synchronous gate for hosts that would otherwise show their own menu:
 *  true when the desktop bridge is here and the url could name a file on
 *  disk — mirrors mediaPath() in electron/main.cjs: /api/file, /api/thumb,
 *  or a public path; never mediaref:/data:/blob:/http or another endpoint.
 *  The async resolve makes the final call; this only decides whether to
 *  take the event. (Plain boolean, not a type guard: false says nothing
 *  about the url's type.) */
export function mayHaveDiskFile(url: string | null | undefined): boolean {
  if (!resolver() || typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//')) return false
  const route = url.toLowerCase()
  if (route === '/api' || route.startsWith('/api/') || route.startsWith('/api.')) {
    return route.startsWith('/api/file?') || route.startsWith('/api/thumb?')
  }
  return true
}

/** The file behind `url`, looked up once per url. `done` is false while the
 *  lookup is in flight, so a host can tell "no file" from "not known yet". */
export function useResolvedFile(url: string | null | undefined): { resolved: ResolvedFile; done: boolean } {
  const [state, setState] = useState<{ url: string | null; resolved: ResolvedFile }>({ url: null, resolved: null })
  const want = typeof url === 'string' && mayHaveDiskFile(url) ? url : null
  useEffect(() => {
    if (!want) return
    let live = true
    resolver()!.resolveMedia!(want)
      .then(r => { if (live) setState({ url: want, resolved: r }) })
      .catch(() => { if (live) setState({ url: want, resolved: null }) })
    return () => { live = false }
  }, [want])
  if (!want) return { resolved: null, done: true }
  return state.url === want ? { resolved: state.resolved, done: true } : { resolved: null, done: false }
}

export function fileMenuItemsFor(resolved: ResolvedFile, close: () => void): FileMenuItem[] {
  const d = window.vidbarsDesktop
  if (!d || !resolved) return []
  const p = resolved.path
  if (!resolved.exists) {
    // Still worth something: where it USED to be is how you find it again.
    // Short on purpose: it has to fit the narrowest host menu (170px).
    return [{
      label: 'Missing: copy path', icon: '⚠️', separator: true,
      action: () => { void d.copyPath(p); close() },
    }]
  }
  return [
    {
      label: d.platform === 'darwin' ? 'Show in Finder' : 'Show in Explorer', icon: '📂', separator: true,
      action: () => { void d.revealPath(p); close() },
    },
    { label: 'Copy path', icon: '📋', action: () => { void d.copyPath(p); close() } },
    {
      label: 'Open', icon: '↗️',
      action: () => {
        void d.openPath(p).then(err => { if (err) console.warn('[vidbars] open failed:', err) })
        close()
      },
    },
  ]
}

export function useFileMenuItems(url: string | null | undefined, close: () => void): FileMenuItem[] {
  return fileMenuItemsFor(useResolvedFile(url).resolved, close)
}
