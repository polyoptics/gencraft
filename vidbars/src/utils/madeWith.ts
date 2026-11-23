// madeWith.ts — what an AI-made picture says about how it was made.
//
// Midjourney writes the prompt into every PNG it hands out (Brian
// 2026-11-10: "keep a key prompt and bring it back... just for saving",
// without typing it again): a text chunk named Description holding the
// whole prompt line, its settings (--ar, --sref <link>, --profile, --v…)
// and "Job ID: <uuid>", beside Author and Creation Time.
//
// readMadeWith() pulls that out of a file's bytes; stampMadeWith() puts it
// where it is kept: on the picture itself (MediaItem.made, the record a
// later generation tree is drawn from) and, for a card's first picture, as
// rows on the card's back. Nothing is asked of the person, and a picture
// that says nothing changes nothing.

import { useBoardsStore } from '../store/boardsStore'
import { getMediaItems, type MediaItem } from '../types/bar'
import { newDetailId, type CardDetail } from './cardTypes'
import { isMediaRef, mediaRefId } from './mediaRef'
import { getMedia } from './mediaStore'

/** How a picture was made, as its file tells it. */
export interface MadeWith {
  by: 'midjourney'
  /** The words of the prompt: no settings, no reference links. */
  prompt: string
  /** The settings as typed, from the first `--` on. */
  settings: string
  /** Every web link in the prompt line: image prompts, --sref, --cref… */
  refs: string[]
  jobId: string
  /** The model version (`--v 8.1`, `--niji 6`), when the line names one. */
  version?: string
  /** When it was made, as the file gives it. */
  at?: string
  author?: string
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
/** Pictures larger than this are not read: the info is in small files'
 *  headers, and a huge file is never a Midjourney download. */
const MAX_BYTES = 80 * 1024 * 1024

/** The text chunks of a PNG, by keyword. tEXt and plain iTXt; a
 *  compressed chunk is passed over. Empty for anything else. */
export function pngText(bytes: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  if (bytes.length < 16 || PNG_SIG.some((b, i) => bytes[i] !== b)) return out
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const latin1 = new TextDecoder('latin1')
  const utf8 = new TextDecoder('utf-8')
  // tEXt is Latin-1 by the book, but writers often put UTF-8 in it: read
  // it as UTF-8 when it is valid UTF-8, so accents and curly quotes hold.
  const utf8Strict = new TextDecoder('utf-8', { fatal: true })
  const textOf = (b: Uint8Array): string => {
    try { return utf8Strict.decode(b) } catch { return latin1.decode(b) }
  }
  let p = 8
  while (p + 12 <= bytes.length) {
    const len = view.getUint32(p)
    const type = latin1.decode(bytes.subarray(p + 4, p + 8))
    const start = p + 8
    const end = start + len
    if (end > bytes.length) break
    if (type === 'tEXt' || type === 'iTXt') {
      const data = bytes.subarray(start, end)
      const nul = data.indexOf(0)
      if (nul > 0) {
        const key = latin1.decode(data.subarray(0, nul))
        if (type === 'tEXt') {
          if (!(key in out)) out[key] = textOf(data.subarray(nul + 1))
        } else if (data[nul + 1] === 0) {
          // keyword, 0, compression flag, method, language, 0, translated, 0, text
          const lang = data.indexOf(0, nul + 3)
          const tr = lang < 0 ? -1 : data.indexOf(0, lang + 1)
          if (tr >= 0 && !(key in out)) out[key] = utf8.decode(data.subarray(tr + 1))
        }
      }
    }
    if (type === 'IEND') break
    p = end + 4
  }
  return out
}

const JOB_ID = /\s*Job ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i
const LINK = /<?https?:\/\/[^\s<>]+>?/g
/** A link as it opens: no brackets, no `::weight`, no trailing comma. */
const cleanLink = (u: string) => u.replace(/^<|>$/g, '').replace(/::-?[\d.]+$/, '').replace(/[,.;)\]]+$/, '')

/** A Midjourney Description line, taken apart. Null when it is not one
 *  (no Job ID at its end). */
export function parseMidjourney(text: Record<string, string>): MadeWith | null {
  const desc = text.Description
  if (!desc) return null
  const job = JOB_ID.exec(desc)
  if (!job) return null
  const line = desc.slice(0, job.index).trim()
  // Settings start at the first " --name"; a "--" inside a word is not one.
  const cut = /(^|\s)--[a-z]/i.exec(line)
  const at = cut ? cut.index + cut[1].length : line.length
  const words = line.slice(0, at)
  const settings = line.slice(at).trim()
  const version = /(?:^|\s)--(v|version|niji)(?=\s|$)(?:\s+(?!--)(\S+))?/i.exec(settings)
  const made: MadeWith = {
    by: 'midjourney',
    prompt: words.replace(LINK, ' ').replace(/\s+/g, ' ').trim(),
    settings,
    refs: [...new Set((line.match(LINK) ?? []).map(cleanLink).filter(Boolean))],
    jobId: job[1].toLowerCase(),
  }
  if (version) {
    const niji = /niji/i.test(version[1])
    const v = niji ? (version[2] ? `niji ${version[2]}` : 'niji') : version[2]
    if (v) made.version = v
  }
  const when = text['Creation Time']?.trim()
  if (when) made.at = when
  const author = text.Author?.trim()
  if (author) made.author = author
  return made
}

/** What a file's bytes say about how it was made, or null. */
export function readMadeWith(bytes: Uint8Array): MadeWith | null {
  return parseMidjourney(pngText(bytes))
}

/** The bytes behind a stored media url, or null when they cannot be had. */
async function bytesOf(url: string): Promise<Uint8Array | null> {
  try {
    let blob: Blob | null
    if (isMediaRef(url)) {
      const id = mediaRefId(url)
      blob = id ? await getMedia(id) : null
    } else {
      const res = await fetch(url)
      if (!res.ok) return null
      if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) { void res.body?.cancel(); return null }
      blob = await res.blob()
    }
    if (!blob || blob.size > MAX_BYTES) return null
    return new Uint8Array(await blob.arrayBuffer())
  } catch {
    return null
  }
}

const DATE_LINE = /^(?:[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT|\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?)$/

/** "26 Oct 2026" from the file's date line; the line itself if it is not
 *  a date. */
function day(at: string): string {
  if (!DATE_LINE.test(at)) return at
  const t = Date.parse(at)
  if (Number.isNaN(t)) return at
  // The day it was where the person is, not the day it was in Greenwich.
  return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
}

/** The rows a card's back gets, in order. Empty ones are left out. */
export function madeRows(made: MadeWith): { name: string; value: string }[] {
  const tool = made.version ? `Midjourney ${made.version}` : 'Midjourney'
  return [
    { name: 'Prompt', value: made.prompt },
    { name: 'Settings', value: made.settings },
    { name: 'References', value: made.refs.join('\n') },
    { name: 'Job ID', value: made.jobId },
    { name: 'Made', value: made.at ? `${tool}, ${day(made.at)}` : tool },
  ].filter(r => r.value)
}

/** The names madeRows() gives its rows, lower case. */
const MADE_NAMES = new Set(['prompt', 'settings', 'references', 'job id', 'made'])

/** True when a card holds a picture that says how it was made. */
type Cards = Pick<ReturnType<typeof useBoardsStore.getState>, 'groups' | 'boards'>
function cardHasMade(s: Cards, groupId: string): boolean {
  const g = s.groups.find(gr => gr.id === groupId)
  return !!g && g.boardIds.some(bid => Object.values(s.boards[bid]?.bars ?? {}).some(bar => getMediaItems(bar.content).some(m => !!m.made)))
}

/** The ids of a card's details that came in with its media rather than
 *  being typed (Brian 2026-11-23: "old prompt settings, job IDs, where it
 *  was made… let's put it in one thing that I can fold"): rows marked so
 *  when they were added, and, on cards filled before rows were marked,
 *  the rows named as madeRows() names them while the card holds a picture
 *  that carries how it was made. Read, never written: the rows stay as
 *  they are. A string (ids joined by a space) so a store selector can
 *  return it. */
export function metaDetailIds(s: Cards, groupId: string): string {
  const details = s.groups.find(g => g.id === groupId)?.details
  if (!details?.length) return ''
  const named = details.filter(d => !d.meta && !d.link && MADE_NAMES.has(d.name.trim().toLowerCase()))
  const old = named.length > 0 && cardHasMade(s, groupId) ? new Set(named.map(d => d.id)) : null
  return details.filter(d => d.meta || old?.has(d.id)).map(d => d.id).join(' ')
}

/** `media` with the moment it came into the project noted, unless it
 *  already carries one (a copy, a trimmed clip of something older). */
export function withAdded(media: MediaItem): MediaItem {
  return media.added ? media : { ...media, added: Date.now() }
}

/** True while no block of the card holds a picture: ask BEFORE filling
 *  one, and the picture about to go in is the card's first. */
export function hasNoPicture(groupId: string): boolean {
  const s = useBoardsStore.getState()
  const g = s.groups.find(gr => gr.id === groupId)
  if (!g) return false
  return !g.boardIds.some(bid => {
    const b = s.boards[bid]
    return Object.values(b?.bars ?? {}).some(bar => getMediaItems(bar.content).some(m => m.type === 'image'))
  })
}

/** A picture has just gone into a card as a block: read what its file
 *  says and keep it. Always on the picture (MediaItem.made). On the
 *  card's back only when `onBack` (its first picture), and only rows the
 *  back does not already have by name, so nothing typed is overwritten.
 *  Not an undo step of its own: it finishes the drop that began it. */
export async function stampMadeWith(groupId: string, boardId: string, media: MediaItem, onBack: boolean): Promise<void> {
  if (media.type !== 'image' || media.made) return
  // Not worth opening: a picture the app drew itself (data:/blob:, a loop
  // strip's result, a snip), or a file named as another picture format.
  if (/^(data|blob):/i.test(media.url)) return
  const OTHER = /\.(jpe?g|gif|webp|avif|bmp|svg|heic|heif|tiff?)$/i
  if (media.originalName && OTHER.test(media.originalName)) return
  let path = media.url.split('#')[0]
  try { path = decodeURIComponent(path) } catch { /* as it is */ }
  if (OTHER.test(path.split('?')[0]) || OTHER.test(path)) return
  const bytes = await bytesOf(media.url)
  const made = bytes && readMadeWith(bytes)
  if (!made) return
  const st = useBoardsStore.getState()
  const board = st.boards[boardId]
  const barId = board?.rootIds[0]
  const items = barId ? board.bars[barId]?.content.media ?? [] : []
  if (barId && items.some(m => m.url === media.url && !m.made)) {
    st.setContent(boardId, barId, { media: items.map(m => m.url === media.url && !m.made ? { ...m, made } : m) })
  }
  if (!onBack) return
  const g = useBoardsStore.getState().groups.find(gr => gr.id === groupId)
  if (!g || !g.boardIds.includes(boardId)) return
  const have = new Set((g.details ?? []).map(d => d.name.trim().toLowerCase()))
  const add: CardDetail[] = madeRows(made)
    .filter(r => !have.has(r.name.toLowerCase()))
    .map(r => ({ id: newDetailId(), name: r.name, value: r.value, meta: true as const }))
  if (add.length) useBoardsStore.getState().setGroupDetails(groupId, [...(g.details ?? []), ...add])
}
