// generationStore.ts — the spine the generation components share.
//
// One store holds every generated image, grouped into SESSIONS, each item
// carrying the prompt and reference images that produced it. That single
// shape serves all three views the design calls for:
//
//   Media Pool      — the flat set of results, browsable
//   History         — the same items grouped by session, prompt visible
//   Prompt Pad      — writes here on submit, and recalls a past prompt
//
// Building them against one store rather than three is what lets a Prompt
// Pad magneted to a Pool actually feed it: there is no wiring between the
// components at all, they are just views over the same rows. That is the
// modular promise — components compose because they share a spine, not
// because they know about each other.
//
// NO PROVIDER IS WIRED. `submit` runs whatever adapter is registered and
// records the result; the default adapter is a local stub that produces
// placeholder tiles so the whole flow is demonstrable. Dropping in a real
// backend means implementing one function — see setGenerationAdapter.

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { createDebouncedIDBStorage } from '../utils/debouncedIDBStorage'

export interface GenItem {
  id: string
  /** Render-ready url: a `data:` URL from the stub, or a `mediaref:` once a
   *  real provider stores bytes. Passed straight to useResolvedMedia. */
  url: string
  prompt: string
  /** Reference images this generation was conditioned on. */
  refs: string[]
  sessionId: string
  createdAt: number
  /** Free-form provider tag, so a mixed history stays legible. */
  source: string
}

export interface GenSession {
  id: string
  label: string
  startedAt: number
}

export interface GenerationRequest {
  prompt: string
  refs: string[]
  count: number
}

/** A provider: given a request, return one url per image. Kept this small
 *  on purpose — everything else (sessions, history, the pool) is already
 *  handled, so a real backend is exactly this one function. */
export type GenerationAdapter = (req: GenerationRequest) => Promise<string[]>

/** Placeholder generator. Draws the prompt onto a tile so a demo reads
 *  correctly without a provider. Data URLs because blob bytes do not
 *  survive in this runtime (see posterService). */
const stubAdapter: GenerationAdapter = async (req) => {
  const out: string[] = []
  for (let i = 0; i < req.count; i++) {
    const c = document.createElement('canvas')
    c.width = 512; c.height = 512
    const ctx = c.getContext('2d')!
    const hue = (Math.abs(hashString(req.prompt + i)) % 360)
    const g = ctx.createLinearGradient(0, 0, 512, 512)
    g.addColorStop(0, `hsl(${hue} 45% 22%)`)
    g.addColorStop(1, `hsl(${(hue + 40) % 360} 55% 12%)`)
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 512, 512)
    ctx.strokeStyle = `hsl(${hue} 70% 60% / 0.5)`
    ctx.lineWidth = 3
    ctx.strokeRect(14, 14, 484, 484)
    ctx.fillStyle = 'rgba(255,255,255,0.86)'
    ctx.font = '600 22px system-ui, sans-serif'
    wrapText(ctx, req.prompt || 'untitled', 34, 70, 444, 30)
    ctx.fillStyle = 'rgba(255,255,255,0.4)'
    ctx.font = '500 15px ui-monospace, monospace'
    ctx.fillText(`stub · ${i + 1}/${req.count}`, 34, 478)
    out.push(c.toDataURL('image/png'))
  }
  return out
}

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return h
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number): void {
  const words = text.split(/\s+/)
  let line = ''
  let yy = y
  for (const w of words) {
    const test = line ? `${line} ${w}` : w
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, yy); line = w; yy += lh
      if (yy > 420) { ctx.fillText('…', x, yy); return }
    } else line = test
  }
  if (line) ctx.fillText(line, x, yy)
}

let adapter: GenerationAdapter = stubAdapter

/** Point generation at a real provider. Call once at startup. */
export function setGenerationAdapter(fn: GenerationAdapter): void {
  adapter = fn
}

export function isUsingStubAdapter(): boolean {
  return adapter === stubAdapter
}

interface GenerationStore {
  items: GenItem[]           // newest first
  sessions: GenSession[]     // newest first
  currentSessionId: string | null
  /** Ids currently being generated — the UI shows them as pending tiles. */
  pending: number
  startSession: (label?: string) => string
  submit: (req: GenerationRequest) => Promise<GenItem[]>
  removeItem: (id: string) => void
  clearAll: () => void
}

export const useGenerationStore = create<GenerationStore>()(persist((set, get) => ({
  items: [],
  sessions: [],
  currentSessionId: null,
  pending: 0,

  startSession: (label) => {
    const id = crypto.randomUUID()
    const session: GenSession = {
      id,
      label: label || `Session ${get().sessions.length + 1}`,
      startedAt: Date.now(),
    }
    set(s => ({ sessions: [session, ...s.sessions], currentSessionId: id }))
    return id
  },

  submit: async (req) => {
    let sid = get().currentSessionId
    if (!sid || !get().sessions.some(s => s.id === sid)) sid = get().startSession()
    set(s => ({ pending: s.pending + req.count }))
    try {
      const urls = await adapter(req)
      const now = Date.now()
      const made: GenItem[] = urls.map((url, i) => ({
        id: crypto.randomUUID(),
        url,
        prompt: req.prompt,
        refs: [...req.refs],
        sessionId: sid!,
        createdAt: now + i,
        source: adapter === stubAdapter ? 'stub' : 'provider',
      }))
      set(s => ({ items: [...made, ...s.items], pending: Math.max(0, s.pending - req.count) }))
      return made
    } catch (err) {
      set(s => ({ pending: Math.max(0, s.pending - req.count) }))
      console.warn('[generation] failed', err)
      return []
    }
  },

  removeItem: (id) => set(s => ({ items: s.items.filter(i => i.id !== id) })),

  clearAll: () => set({ items: [], sessions: [], currentSessionId: null, pending: 0 }),
}), {
  name: 'vidbars-generations',
  storage: createDebouncedIDBStorage(400),
  partialize: (s) => ({ items: s.items, sessions: s.sessions, currentSessionId: s.currentSessionId }),
}))
