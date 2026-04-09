export type MediaType = 'image' | 'video' | 'audio'

export interface MediaItem {
  url: string
  type: MediaType
  originalName?: string
  /** Static poster frame URL for videos (used at block/card zoom) */
  posterUrl?: string
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
}

/** Helper: get all media items from a bar's content (bridges old images[] and new media[]) */
export function getMediaItems(content: BarContent | undefined): MediaItem[] {
  if (!content) return []
  if (content.media && content.media.length > 0) return content.media
  // Fallback: map legacy images[] to MediaItem[]
  return (content.images ?? []).map(url => ({ url, type: 'image' as MediaType }))
}

/** Helper: get the first image URL (for thumbnails) */
export function getFirstImageUrl(content: BarContent | undefined): string | null {
  const items = getMediaItems(content)
  // Prefer images, then video posters
  const img = items.find(m => m.type === 'image')
  if (img) return img.url
  const vid = items.find(m => m.type === 'video' && m.posterUrl)
  if (vid) return vid.posterUrl!
  // Last resort: any URL (video without poster shows as thumbnail)
  return items[0]?.url ?? null
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
}
