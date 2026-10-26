// preload.cjs — the only surface the app sees of the desktop.
//
// Exposed as `window.vidbarsDesktop`, typed in src/types/desktop.d.ts. Its
// ABSENCE is how the app knows it is running in a plain browser, so every
// caller must treat it as optional. Keep this list short: each entry is a
// capability a web page could not otherwise have.

const { contextBridge, ipcRenderer, webUtils } = require('electron')

// Drag-out is ARMED by a real (trusted) dragstart and spent by the first
// startMediaDrag after it. An OS drag begun with the mouse button already
// up drops at once onto whatever is under the cursor, so a call no real
// gesture started — any script on the page — must do nothing. This capture
// listener is registered before any page script, so it sees the event first.
let armedAt = -1
window.addEventListener('dragstart', e => { if (e.isTrusted) armedAt = performance.now() }, true)

// True while our own drag is out, so the page can ignore it coming back:
// released over VidBars it would otherwise be imported as a duplicate.
let draggingOut = false
ipcRenderer.on('vb:drag-out-done', () => {
  // The page's drop event and this message travel different pipes.
  setTimeout(() => { draggingOut = false }, 300)
})

contextBridge.exposeInMainWorld('vidbarsDesktop', {
  platform: process.platform,

  /** The real path of a File from a drop or <input type=file>; '' when the
   *  File did not come from disk (a pasted image, a generated blob). */
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) } catch { return '' }
  },

  /** Open Explorer / Finder with the file selected. */
  revealPath: (p) => ipcRenderer.invoke('vb:reveal', p),

  /** Open in the OS default app. Resolves '' on success, else a message. */
  openPath: (p) => ipcRenderer.invoke('vb:open', p),

  /** Put the path on the clipboard, for an upload box's file dialog. */
  copyPath: (p) => ipcRenderer.invoke('vb:copy-path', p),

  exists: (p) => ipcRenderer.invoke('vb:exists', p),

  /** The file on disk behind a STORED media value ('/api/file?path=…',
   *  '/uploads/x.png'), as { path, exists } — or null when it has none
   *  (mediaref:, data:, http). */
  resolveMedia: (url) => ipcRenderer.invoke('vb:resolve-media', url),

  /** True when a dropped file can be referenced in place: a media file
   *  that exists and is not a temp copy (zip / email drags). */
  isStablePath: (p) => ipcRenderer.invoke('vb:stable-path', p),

  /** Drag the files behind STORED media values out of the app — into a
   *  website's upload box or another program. Call from a dragstart handler
   *  after e.preventDefault(); main resolves the urls, so there is nothing
   *  to await. Ignored unless a real dragstart just happened (see armedAt). */
  startMediaDrag: (urls) => {
    if (armedAt < 0 || performance.now() - armedAt > 250) return
    armedAt = -1
    draggingOut = true
    ipcRenderer.send('vb:start-drag-media', urls)
  },

  /** True while a drag this window started is still out (and briefly
   *  after): a drop arriving then is our own file coming back. */
  isDraggingOut: () => draggingOut,

  /** Warm the drag image (the file's own thumbnail). Call on hover: the
   *  drag itself cannot wait for it. */
  prepareDragIcon: (url) => ipcRenderer.invoke('vb:prepare-drag', url),

  /** Save an image the app made (a PNG/JPEG data url) as a real file in
   *  Pictures — kind 'context-sheet' or 'effect' picks the folder; 'drag'
   *  is a drag-out copy in the app's own Drag Cache, pruned to a budget.
   *  Never overwrites. Resolves { path } of the file written, or { error }. */
  saveImage: (kind, name, dataUrl) => ipcRenderer.invoke('vb:save-image', kind, name, dataUrl),
})
