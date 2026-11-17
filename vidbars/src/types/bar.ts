export type MediaType = 'image' | 'video' | 'audio' | 'model'

export interface MediaItem {
  url: string
  type: MediaType
  originalName?: string
  /** Static poster frame URL for videos and 3D models (used at block/card zoom) */
  posterUrl?: string
  /** A video's chosen thumbnail: the time (seconds) of the frame its
   *  posterUrl was taken from ("Set as thumbnail"). Absent: the first frame. */
  posterTime?: number
  /** The poster it had before a thumbnail was chosen, for "Reset thumbnail". */
  posterOriginal?: string
  /** A shot of the film the Film Look mixer can mix (its clip name, f18h):
   *  set on the shot cards it makes, and how a card docked to it fills it. */
  filmShot?: string
  /** A trimmed clip (a Rough Cut's blocks, and the cards pulled out of one):
   *  the part of the source it plays, in seconds. Absent: all of it. */
  clipIn?: number
  clipOut?: number
  /** The source's own length, seconds, once read (videos and audio). */
  duration?: number
  /** The frame it is shown in when made into a movie or a GIF (set on the
   *  cards a Rough Cut with a frame hands out): the frame's shape, width ÷
   *  height, and whether it fills it (its overhang cut off) or is fitted
   *  inside (black around it); then its own zoom and place in the frame
   *  (utils/shotFrame). Absent: its own shape. */
  frame?: { aspect: number; fill?: boolean; zoom?: number; x?: number; y?: number }
  /** How an AI-made picture was made, read from its own file when it came
   *  in (utils/madeWith): prompt, settings, reference links, job id. */
  made?: import('../utils/madeWith').MadeWith
  /** When it came into the project (ms since 1970), noted once as it first
   *  goes into a card and kept through copies. Nothing shows it yet: it is
   *  there for the record of how a piece was made. */
  added?: number
}

export interface BarTextStyle {
  fontSize: number
  color: string
  bgColor: string
  bgOpacity: number
  bold: boolean
  italic: boolean
  align: 'left' | 'center' | 'right'
  vAlign: 'top' | 'middle' | 'bottom'
}

export const DEFAULT_BAR_TEXT_STYLE: BarTextStyle = {
  fontSize: 18,
  color: '#ffffff',
  bgColor: '#000000',
  bgOpacity: 0,
  bold: false,
  italic: false,
  align: 'left',
  vAlign: 'top',
}

export interface BarContent {
  text: string
  textStyle?: BarTextStyle
  headerText?: string
  headerTextStyle?: BarTextStyle
  images: string[]   // legacy — data URLs or file paths
  media: MediaItem[] // new — typed media items
  mentions: string[] // @mention strings e.g. "@A.Yuki"
  textSplitRatio?: number // header/body vertical split (0-1, default 0.5)
  imageTransform?: import('../store/boardsStore').HeroImageTransform
}

/** Helper: get all media items from a bar's content (bridges old images[] and new media[]) */
export function getMediaItems(content: BarContent | undefined): MediaItem[] {
  if (!content) return []
  if (content.media && content.media.length > 0) return content.media
  // Fallback: map legacy images[] to MediaItem[]
  return (content.images ?? []).map(url => ({ url, type: 'image' as MediaType }))
}

/** Helper: get the first image URL (for thumbnails).
 *  NEVER returns a raw video, audio or 3D-model URL — every consumer feeds
 *  this into an <img>/background-image, where those render blank or as a
 *  broken-image icon. Video and models contribute only via their posterUrl
 *  (useVideoPosterBackfill fills it for videos). */
export function getFirstImageUrl(content: BarContent | undefined): string | null {
  const items = getMediaItems(content)
  // Prefer images, then video/model posters
  const img = items.find(m => m.type === 'image')
  if (img) return img.url
  const posterable = items.find(m => (m.type === 'video' || m.type === 'model') && m.posterUrl)
  return posterable?.posterUrl ?? null
}

/** The stored url of the media item getFirstImageUrl() is SHOWING — the
 *  video or model itself, never its poster. This is the file behind the
 *  picture, for "Show in Explorer" and friends; do not render it. */
export function getFirstMediaSource(content: BarContent | undefined): string | null {
  const items = getMediaItems(content)
  const img = items.find(m => m.type === 'image')
  if (img) return img.url
  const posterable = items.find(m => (m.type === 'video' || m.type === 'model') && m.posterUrl)
  return posterable?.url ?? null
}

export interface Bar {
  id: string
  name: string
  subtitle: string         // secondary label shown under the name
  icon: string | null      // base64 data URL for the icon image
  color: string
  children: string[]       // ordered child IDs (rendered in row below)
  parentId: string | null
  rowIndex: number         // depth level; 0 = top row
  x: number               // absolute x in canvas layout units
  width: number           // block width
  height: number          // individual block height
  content: BarContent
  collapsed?: boolean   // true = children are hidden
  /** References this ELEMENT owns — see utils/linkTargets. */
  linkedRefs?: import('../utils/linkTargets').LinkRef[]
  /** Annotation layer — vector strokes drawn on this bar at board zoom.
   *  Same shape across every drawable surface; see types/stroke.ts. */
  strokes?: import('./stroke').Stroke[]
  /** A note made in a Rough Cut, on the clip it is about: its time in the
   *  clip's source (seconds). Lives on the node layer, under the clip's bar. */
  cutNote?: { t: number }
}
