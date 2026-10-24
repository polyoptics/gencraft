// preload.cjs — the only surface the app sees of the desktop.
//
// Exposed as `window.vidbarsDesktop`, typed in src/types/desktop.d.ts. Its
// ABSENCE is how the app knows it is running in a plain browser, so every
// caller must treat it as optional. Keep this list short: each entry is a
// capability a web page could not otherwise have.

const { contextBridge, ipcRenderer, webUtils } = require('electron')

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

  /** Begin a real OS file drag. Call from a dragstart handler AFTER
   *  e.preventDefault(), so the HTML drag gives way to the native one. */
  startFileDrag: (paths) => ipcRenderer.send('vb:start-drag', paths),
})
