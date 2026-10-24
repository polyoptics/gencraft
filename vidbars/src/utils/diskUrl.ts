// diskUrl.ts — how a file on disk is named in stored state, and how any
// stored url is put into CSS.
//
// Shared by the app AND vite.config.ts (browseApi, /api/file), so it must
// stay free of DOM and Node APIs: one encoder and one allowlist on both
// sides of the wire.

/** encodeURIComponent, plus the five characters it leaves alone — ! ' ( ) *.
 *  Windows names `image (1).png` all the time, and a bare ( or ) ends an
 *  unquoted CSS url() early, so the picture silently renders nothing. */
export function encodeUrlParam(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g,
    c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

/** The stored url for a file referenced IN PLACE on disk. Served by the dev
 *  server's /api/file; the desktop bridge maps it back to the path.
 *
 *  `version` (size + mtime of the file as dropped) goes FIRST so the url
 *  still ends in the file name — modelCache sniffs `.fbx` off the end. It
 *  exists because posters and parsed models are cached by url: without it,
 *  re-dropping a model re-exported to the same path would show the old one
 *  forever. Readers only ever look at `path`. */
export function diskFileUrl(absPath: string, version?: string): string {
  return version
    ? `/api/file?v=${encodeUrlParam(version)}&path=${encodeUrlParam(absPath)}`
    : `/api/file?path=${encodeUrlParam(absPath)}`
}

/** File kinds /api/file will serve: media, plus the sidecars a model can
 *  load next to itself. Anything else (an .exe, a .env, a key file) is
 *  refused, so a reference can never become a way to read arbitrary disk.
 *  electron/main.cjs keeps an identical copy (MEDIA_FILE). */
const SERVABLE = /\.(png|jpe?g|jfif|webp|gif|avif|bmp|svg|ico|tiff?|heic|jxl|mp4|webm|mov|m4v|mkv|ogv|mp3|wav|ogg|oga|opus|m4a|aac|flac|glb|gltf|fbx|obj|bin|ktx2|tga|hdr|exr|dds)$/i

export function isServableDiskPath(p: string): boolean {
  return SERVABLE.test(p)
}

/** \\host\share, //host/share, \\?\UNC\…, \\.\… — merely touching one makes
 *  Windows authenticate to a remote host, and stored values can arrive in
 *  an imported project. Refuse before ANY fs call. */
export function isUncPath(p: string): boolean {
  return /^[\\/]{2}/.test(p)
}

/** A stored url as a CSS `url(...)` value. Always quoted: stored values
 *  predating encodeUrlParam can still contain ( ) ' or spaces. */
export function cssUrl(u: string): string {
  return `url("${u.replace(/["\\]/g, '\\$&').replace(/[\r\n]/g, '')}")`
}
