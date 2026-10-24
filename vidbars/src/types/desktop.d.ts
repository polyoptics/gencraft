// The desktop bridge exposed by electron/preload.cjs.
//
// OPTIONAL by design: undefined in a plain browser tab. Feature-detect with
// `window.vidbarsDesktop` and fall back to doing nothing — never assume it.

export interface VidbarsDesktop {
  platform: string
  /** Real path of a File from a drop or file input; '' if it has none. */
  pathForFile(file: File): string
  /** Open Explorer / Finder with the file selected. False if not found. */
  revealPath(path: string): Promise<boolean>
  /** Open in the OS default app. '' on success, else an error message. */
  openPath(path: string): Promise<string>
  /** Copy the path to the clipboard. */
  copyPath(path: string): Promise<boolean>
  exists(path: string): Promise<boolean>
  /** Start a native OS file drag. Call inside dragstart after preventDefault(). */
  startFileDrag(paths: string | string[]): void

  // Added after the first five. OPTIONAL in the type because a hot reload
  // swaps the app's code while an older preload keeps running until the
  // window restarts — feature-detect each one, not just the bridge.

  /** The file behind a STORED media value, or null when it has none
   *  (mediaref:, data:, http). `exists` is false when it moved or was deleted. */
  resolveMedia?(url: string): Promise<{ path: string; exists: boolean } | null>
  /** A dropped file that can be referenced in place (not a temp copy). */
  isStablePath?(path: string): Promise<boolean>
}

declare global {
  interface Window {
    vidbarsDesktop?: VidbarsDesktop
  }
}
