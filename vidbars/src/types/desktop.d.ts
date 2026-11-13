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

  // Added after the first five. OPTIONAL in the type because a hot reload
  // swaps the app's code while an older preload keeps running until the
  // window restarts — feature-detect each one, not just the bridge.

  /** The file behind a STORED media value, or null when it has none
   *  (mediaref:, data:, http). `exists` is false when it moved or was deleted. */
  resolveMedia?(url: string): Promise<{ path: string; exists: boolean } | null>
  /** A dropped file that can be referenced in place (not a temp copy). */
  isStablePath?(path: string): Promise<boolean>
  /** Drag the files behind STORED media values out of the app. Call inside
   *  a real dragstart after preventDefault() — anything else is ignored;
   *  main resolves the urls itself. */
  startMediaDrag?(urls: string[]): void
  /** True while this window's own drag is out: a drop then is that file
   *  coming back, not a new one. */
  isDraggingOut?(): boolean
  /** Warm the drag image for a stored url (on hover). */
  prepareDragIcon?(url: string): Promise<boolean>
  /** Save an image the app made (PNG/JPEG data url) as a real file in
   *  Pictures\VidBars Context Sheets or \VidBars Effects (a local folder
   *  instead when Pictures is on a network share), or for kind 'drag' in
   *  the Drag Cache (see SaveImageKind). Never overwrites: a taken
   *  name gets " (2)", " (3)"… Resolves the path written, or why not.
   *  A bare string | null comes from a main older than this page — it only
   *  restarts with the window. Go through utils/saveImage.ts. */
  saveImage?(kind: SaveImageKind, name: string, dataUrl: string): Promise<{ path: string } | { error: string } | string | null>
  /** Depth / Segment / Film outline / hatch cards: sketchLook's depth.py,
   *  matte_auto.py or look_hybrid_colerase.py on this machine's GPU
   *  (electron/sketchWorker.cjs). `frames` are data urls; more than one is a
   *  short sequence. `objects`: phrases per thing to find (segment, lines).
   *  Depth gives a grey map per frame (near = bright); segment a mask per
   *  frame for each thing found, plus 'figure' (all of them); lines the
   *  outline, inside, paper and pencil layers per frame (alpha, grey) and
   *  the look's colours, drawn at long edge `side` with `dials`; formhatch /
   *  bghatch their multiply and screen layers (look_formhatch.py,
   *  look_bg_depthhatch.py). */
  mixerStatus?(): Promise<{ running: boolean; starting: boolean; url: string }>
  mixerStart?(): Promise<{ url?: string; error?: string; log?: string }>
  mixerView?(): Promise<{
    seg: number; i: number; clip: string; overlay: boolean; cardOn: boolean; playing: boolean
    /** Where the picture sits in the page, in the page's own pixels. */
    picture: { x: number; y: number; width: number; height: number }
    /** Null on a graphics-only shot. */
    look: Record<string, number> | null
  } | null>
  mixerCall?(op: 'shots', clips?: string[]): Promise<{ k: number; clip: string; look: boolean; n: number; start: number | null; end: number | null }[] | null>
  mixerCall?(op: 'sel', clips?: string[]): Promise<string[] | null>
  mixerCall?(op: 'looks', clips?: string[]): Promise<{ name: string; colour: string }[] | null>
  mixerCall?(op: 'film', clips?: string[]): Promise<{ frames: number; shots: { clip: string; start: number; end: number }[] } | null>
  mixerCall?(op: 'embed' | 'use' | 'go', clips?: string[]): Promise<unknown>
  mixerThumb?(seg: number): Promise<string | null>
  mixerFrame?(job: { seg: number; i: number; look: Record<string, number> | null; card: boolean }):
    Promise<{ url?: string; loading?: boolean; error?: string }>
  sketchRun?(job: {
    op: 'depth' | 'segment' | 'lines' | 'formhatch' | 'bghatch' | 'look'; frames: string[]
    /** op 'look': which drawing look (sketch_server.py LOOKS). */
    look?: string; objects?: Record<string, string[]>
    side?: number; dials?: Record<string, number>
    /** What finds the things: SAM 3 (default where installed) or Grounding DINO + SAM2. */
    engine?: 'sam3' | 'dino'
    /** Nothing named: the whole picture is the subject (no segmenting). */
    whole?: boolean
    /** A chunk of a clip sketchClip opened, in place of `frames`: drawn as
     *  one sequence, its results handed back as file paths, not data urls. */
    clip?: { id: string; start: number; count: number }
  }): Promise<{
    frames?: (string | Record<string, string>)[]; objects?: Record<string, string[]>
    colors?: Record<string, string | number>; error?: string; log: string; engine?: 'sam3' | 'dino'
  }>
  /** A video card's file, opened for a bake through the sketch looks (by
   *  its stored url): its id, frame rate, frame count and size. */
  sketchClip?(url: string): Promise<{ id: string; fps: number; n: number; w: number; h: number; audio: boolean } | { error: string }>
  /** Frames start .. start+count of an opened clip, read out as PNG files. */
  sketchClipFrames?(c: { id: string; start: number; count: number }): Promise<{ paths: string[] } | { error: string }>
  /** One drawn frame (a JPEG data url) of a clip bake, frame i of the clip. */
  sketchBakeFrame?(bake: string, i: number, dataUrl: string): Promise<{ error?: string }>
  /** A stopped bake: its frames go. */
  sketchBakeDrop?(bake: string): Promise<void>
  /** A bake's frames as an MP4 (with the clip's sound) in Pictures\VidBars Effects;
   *  with `gif`, a looping GIF instead (a main from before GIFs makes an MP4). */
  sketchBakeEncode?(bake: string, c: { id: string; start: number; count: number }, name: string, opts?: { gif?: boolean }): Promise<{ path: string } | { error: string }>
}

/** Where a save lands: 'context-sheet' and 'effect' are the user's files
 *  (Pictures\VidBars Context Sheets, \VidBars Effects); 'drag' is a
 *  drag-out copy prepared ahead of a drag (an effect result on its
 *  picture), in the app's own Drag Cache, held to a budget (files older
 *  than 2 days go at startup; past 100 files or 400 MB the oldest go) —
 *  never a place to keep anything. 'gif' is a looping GIF made from a movie
 *  or a deck of shots (Pictures\VidBars GIFs). A main older than 'drag' answers
 *  { error: 'Not allowed' } until the window restarts. */
export type SaveImageKind = 'context-sheet' | 'effect' | 'drag' | 'gif'

declare global {
  interface Window {
    vidbarsDesktop?: VidbarsDesktop
  }
}
