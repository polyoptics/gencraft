// agentChat.ts — the chat boxes inside VidBars (Brian 2026-11-18): talk to
// Claude from the app, and Claude works on the canvas through the
// connector (utils/agentDoor) with its pointer showing (utils/agentCursor).
//
// Each message is sent to the dev server (/api/agent-chat, vite.config.ts),
// which runs Claude Code on this PC under the plan already signed in and
// passes back what it prints, one event a line. A conversation carries on
// by its session id; Claude Code keeps the conversations on this PC.
//
// There can be several boxes, and each has its own history (Brian
// 2026-11-18): its own lines, its own conversation with Claude, nothing
// shared between them but the canvas they all work on. The boxes and what
// was said in them are kept (localStorage) so they are there after a
// restart. "New conversation" starts a box afresh.
//
// Kept apart from how it looks (components/UI/AgentChat.tsx): the boxes'
// look and place are Brian's to decide.

import { create } from 'zustand'

export interface ChatLine {
  id: number
  /** me: the artist; claude: its words; did: a few words on a tool it
   *  used; error: something that stopped it. */
  who: 'me' | 'claude' | 'did' | 'error'
  text: string
}

export interface ChatBox {
  id: string
  lines: ChatLine[]
  /** The conversation Claude Code carries on. Empty: the next message starts one. */
  session: string
  /** Where its top-left is, screen px, once it has been dragged. Absent: its place in the row. */
  at?: { x: number; y: number }
  /** Its own width and height, px, once an edge or corner has been dragged. Absent: the plain size. */
  size?: { w: number; h: number }
  /** The whole box bigger or smaller (Shift + a corner). Absent: 1. */
  scale?: number
}

interface AgentChatState {
  /** The boxes are on screen. */
  open: boolean
  boxes: ChatBox[]
  /** The boxes Claude is working in right now. Not kept. */
  busy: Record<string, boolean>
}

const KEY = 'vidbars.agentChat'
const KEEP = 400
const newId = () => Math.random().toString(36).slice(2, 10)

function load(): ChatBox[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (v && Array.isArray(v.boxes)) return v.boxes.filter((b: ChatBox) => b && typeof b.id === 'string' && Array.isArray(b.lines))
    // The first version kept one conversation.
    if (v && Array.isArray(v.lines)) return [{ id: newId(), lines: v.lines, session: typeof v.session === 'string' ? v.session : '' }]
  } catch { /* private window */ }
  return []
}

export const useAgentChat = create<AgentChatState>(() => ({ open: false, busy: {}, boxes: load() }))

useAgentChat.subscribe((s, was) => {
  if (s.boxes === was.boxes) return
  try { localStorage.setItem(KEY, JSON.stringify({ boxes: s.boxes.map(b => ({ ...b, lines: b.lines.slice(-KEEP) })) })) } catch { /* private window */ }
})

let nextId = Math.max(0, ...useAgentChat.getState().boxes.flatMap(b => b.lines.map(l => l.id))) + 1

const patch = (boxId: string, fn: (b: ChatBox) => ChatBox) =>
  useAgentChat.setState(s => ({ boxes: s.boxes.map(b => b.id === boxId ? fn(b) : b) }))
const add = (boxId: string, who: ChatLine['who'], text: string) =>
  patch(boxId, b => ({ ...b, lines: [...b.lines, { id: nextId++, who, text }].slice(-KEEP) }))

const stoppers = new Map<string, AbortController>()

/** Show or hide the boxes (the top bar's button). Shown with none yet: the first one is made. */
export function toggleChat(): void {
  useAgentChat.setState(s => s.open ? { open: false } : { open: true, boxes: s.boxes.length ? s.boxes : [{ id: newId(), lines: [], session: '' }] })
}

/** Another box, with a history of its own. */
export function addChatBox(): void {
  useAgentChat.setState(s => ({ open: true, boxes: [...s.boxes, { id: newId(), lines: [], session: '' }] }))
}

/** Close a box: it and what was said in it go. The last one is only put away. */
export function closeChatBox(boxId: string): void {
  if (useAgentChat.getState().boxes.length <= 1) { useAgentChat.setState({ open: false }); return }
  stopChat(boxId)
  useAgentChat.setState(s => ({ boxes: s.boxes.filter(b => b.id !== boxId) }))
}

/** A box dragged to a place of its own. */
export function moveChatBox(boxId: string, at: { x: number; y: number }): void {
  patch(boxId, b => ({ ...b, at }))
}

/** A box reshaped (an edge or corner dragged) or scaled whole (Shift + a corner). */
export function shapeChatBox(boxId: string, to: { at: { x: number; y: number }; size: { w: number; h: number }; scale: number }): void {
  patch(boxId, b => ({ ...b, at: to.at, size: to.size, scale: to.scale === 1 ? undefined : to.scale }))
}

/** The few words shown for a tool Claude used: its own (`doing`), or the tool's name in plain words. */
function didText(name: string, input: Record<string, unknown> | undefined): string {
  const doing = typeof input?.doing === 'string' ? input.doing.trim() : ''
  if (doing) return doing
  // Its own housekeeping (finding a tool, thinking aloud) is not shown.
  if (!name.startsWith('mcp__')) return ''
  return name.replace(/^mcp__/, '').replace(/^vidbars__/, '').replace(/__/g, ': ').replace(/_/g, ' ')
}

type Block = { type: string; text?: string; name?: string; input?: Record<string, unknown> }

function take(boxId: string, ev: Record<string, unknown>): void {
  if (typeof ev.session_id === 'string' && ev.type === 'system' && ev.subtype === 'init') patch(boxId, b => ({ ...b, session: ev.session_id as string }))
  if (ev.type === 'assistant') {
    const content = (ev.message as { content?: Block[] } | undefined)?.content ?? []
    for (const b of content) {
      if (b.type === 'text' && b.text?.trim()) add(boxId, 'claude', b.text.trim())
      else if (b.type === 'tool_use' && b.name) { const d = didText(b.name, b.input); if (d) add(boxId, 'did', d) }
    }
  } else if (ev.type === 'result' && ev.is_error) {
    add(boxId, 'error', typeof ev.result === 'string' && ev.result ? ev.result : 'Claude stopped before finishing.')
  } else if (ev.type === 'vidbars_error') {
    add(boxId, 'error', String(ev.error ?? 'Something went wrong.'))
  }
}

const setBusy = (boxId: string, on: boolean) =>
  useAgentChat.setState(s => { const busy = { ...s.busy }; if (on) busy[boxId] = true; else delete busy[boxId]; return { busy } })

/** Say `text` to Claude in box `boxId`. One message at a time in a box. */
export async function sendChat(boxId: string, text: string): Promise<void> {
  const t = text.trim()
  const st = useAgentChat.getState()
  const box = st.boxes.find(b => b.id === boxId)
  if (!t || !box || st.busy[boxId]) return
  add(boxId, 'me', t)
  setBusy(boxId, true)
  const stopper = new AbortController()
  stoppers.set(boxId, stopper)
  try {
    const res = await fetch('/api/agent-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VidBars-Agent': '1' },
      body: JSON.stringify({ text: t, session: box.session }),
      signal: stopper.signal,
    })
    if (!res.ok || !res.body) throw new Error(res.status === 404 ? 'VidBars needs a restart before the chat box can talk to Claude.' : `The chat could not start (${res.status}).`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        try { take(boxId, JSON.parse(line)) } catch { /* not an event */ }
      }
    }
  } catch (e) {
    if ((e as { name?: string } | null)?.name === 'AbortError') add(boxId, 'did', 'Stopped')
    else add(boxId, 'error', e instanceof Error ? e.message : String(e))
  } finally {
    stoppers.delete(boxId)
    setBusy(boxId, false)
  }
}

/** Stop Claude where it is, in box `boxId`. */
export function stopChat(boxId: string): void { stoppers.get(boxId)?.abort() }

/** A fresh conversation in box `boxId`: what was said is cleared from it, and Claude starts with no memory of it. */
export function newChat(boxId: string): void {
  stopChat(boxId)
  patch(boxId, b => ({ ...b, lines: [], session: '' }))
}
