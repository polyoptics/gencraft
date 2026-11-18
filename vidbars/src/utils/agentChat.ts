// agentChat.ts — the chat box inside VidBars (Brian 2026-11-18): talk to
// Claude from the app, and Claude works on the canvas through the
// connector (utils/agentDoor) with its pointer showing (utils/agentCursor).
//
// Each message is sent to the dev server (/api/agent-chat, vite.config.ts),
// which runs Claude Code on this PC under the plan already signed in and
// passes back what it prints, one event a line. A conversation carries on
// by its session id; Claude Code keeps the conversations on this PC, and
// this box keeps what was said (localStorage) so it is there after a
// restart. "New conversation" starts a fresh one.
//
// Kept apart from how it looks (components/UI/AgentChat.tsx): the box's
// look and place are Brian's to decide.

import { create } from 'zustand'

export interface ChatLine {
  id: number
  /** me: the artist; claude: its words; did: a few words on a tool it
   *  used; error: something that stopped it. */
  who: 'me' | 'claude' | 'did' | 'error'
  text: string
}

interface AgentChatState {
  open: boolean
  lines: ChatLine[]
  /** The conversation Claude Code carries on. Empty: the next message starts one. */
  session: string
  busy: boolean
}

const KEY = 'vidbars.agentChat'
const KEEP = 400

function load(): Pick<AgentChatState, 'lines' | 'session'> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || 'null')
    if (v && Array.isArray(v.lines)) return { lines: v.lines, session: typeof v.session === 'string' ? v.session : '' }
  } catch { /* private window */ }
  return { lines: [], session: '' }
}

export const useAgentChat = create<AgentChatState>(() => ({ open: false, busy: false, ...load() }))

useAgentChat.subscribe((s, was) => {
  if (s.lines === was.lines && s.session === was.session) return
  try { localStorage.setItem(KEY, JSON.stringify({ lines: s.lines.slice(-KEEP), session: s.session })) } catch { /* private window */ }
})

let nextId = Math.max(0, ...useAgentChat.getState().lines.map(l => l.id)) + 1
const add = (who: ChatLine['who'], text: string) =>
  useAgentChat.setState(s => ({ lines: [...s.lines, { id: nextId++, who, text }].slice(-KEEP) }))

let stopper: AbortController | null = null

/** The few words shown for a tool Claude used: its own (`doing`), or the tool's name in plain words. */
function didText(name: string, input: Record<string, unknown> | undefined): string {
  const doing = typeof input?.doing === 'string' ? input.doing.trim() : ''
  if (doing) return doing
  // Its own housekeeping (finding a tool, thinking aloud) is not shown.
  if (!name.startsWith('mcp__')) return ''
  return name.replace(/^mcp__/, '').replace(/^vidbars__/, '').replace(/__/g, ': ').replace(/_/g, ' ')
}

type Block = { type: string; text?: string; name?: string; input?: Record<string, unknown> }

function take(ev: Record<string, unknown>): void {
  if (typeof ev.session_id === 'string' && ev.type === 'system' && ev.subtype === 'init') useAgentChat.setState({ session: ev.session_id })
  if (ev.type === 'assistant') {
    const content = (ev.message as { content?: Block[] } | undefined)?.content ?? []
    for (const b of content) {
      if (b.type === 'text' && b.text?.trim()) add('claude', b.text.trim())
      else if (b.type === 'tool_use' && b.name) { const d = didText(b.name, b.input); if (d) add('did', d) }
    }
  } else if (ev.type === 'result' && ev.is_error) {
    add('error', typeof ev.result === 'string' && ev.result ? ev.result : 'Claude stopped before finishing.')
  } else if (ev.type === 'vidbars_error') {
    add('error', String(ev.error ?? 'Something went wrong.'))
  }
}

/** Say `text` to Claude. One message at a time. */
export async function sendChat(text: string): Promise<void> {
  const t = text.trim()
  if (!t || useAgentChat.getState().busy) return
  add('me', t)
  useAgentChat.setState({ busy: true })
  stopper = new AbortController()
  try {
    const res = await fetch('/api/agent-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VidBars-Agent': '1' },
      body: JSON.stringify({ text: t, session: useAgentChat.getState().session }),
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
        try { take(JSON.parse(line)) } catch { /* not an event */ }
      }
    }
  } catch (e) {
    if ((e as { name?: string } | null)?.name === 'AbortError') add('did', 'Stopped')
    else add('error', e instanceof Error ? e.message : String(e))
  } finally {
    stopper = null
    useAgentChat.setState({ busy: false })
  }
}

/** Stop Claude where it is. */
export function stopChat(): void { stopper?.abort() }

/** A fresh conversation: what was said is cleared from the box, and Claude starts with no memory of it. */
export function newChat(): void {
  stopChat()
  useAgentChat.setState({ lines: [], session: '' })
}
