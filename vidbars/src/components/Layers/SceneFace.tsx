// A SCENE card's face (Brian's storyMap): its divisions, named and
// coloured, filling the face. Laid out as a media sheet (Brian 2026-11-07):
// tight gaps, each division holding one card (its picture filling the box,
// cropped like a card face, its name and type on top) or notes text, its
// label in the middle and/or on a small tab at its top-right edge. A
// division made short drops to one row: a round picture, the name, the
// card's main text.
//
// Click a division to pick it: the bar along the face's bottom then holds
// its tools (divide, colour, label switches, bump out, open as its own
// scene card, take the card out, remove). Click its name again to rename
// it; double-click an empty one to write in it. Drag the line between two
// to resize them. The same bar holds the scene's view modes: Focus (click
// divisions to light them, a section's heading lights the section),
// Bump-outs (marked divisions stand taller), Trace (only divisions whose
// card or text matches stay lit, with the headings on the path to them).
// A card's link "+" or the card itself let go on a division puts it there
// (CardLayer, LinkDragOverlay). Data: ProjectGroup.scene / sceneView
// (utils/sceneCard).

import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useLinkDragStore } from '../../store/linkDragStore'
import { cardFaceMedia } from '../../utils/cardGrid'
import { cardTitle } from '../../utils/faceStyle'
import { CARD_TYPES } from '../../utils/cardTypes'
import {
  divBoxes, findDiv, heldCard, isLeaf, leaves, litDivisions, patchDiv, removeDiv, resizeSplit, splitDiv, takeCard,
  type SceneDiv, type SceneView,
} from '../../utils/sceneCard'
import { openDivision } from '../../utils/sceneOpen'
import { ColorPickerPopup } from '../Bar/ColorPickerPopup'

/** Laid out at a new card's size and scaled with the card, like its back. */
const NAT_W = 125
const NAT_H = 184
const GAP = 1.2
const PAD = 1.6
/** A division this short (layout units) is drawn as one row. */
const ROW_H = 15

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const stopPress = (e: React.PointerEvent) => { if (e.button === 0) e.stopPropagation() }
type Box = { x: number; y: number; w: number; h: number }

/** Matches a trace: the card's name, type, text and details, or the
 *  division's own name and notes. */
function traceMatch(d: SceneDiv, card: ProjectGroup | undefined, groups: ProjectGroup[], q: string): boolean {
  const n = q.trim().toLowerCase()
  if (!n) return true
  const hay = [d.name, d.notes]
  if (card) {
    hay.push(cardTitle(groups, card), card.name, card.cardText, card.cardType ? CARD_TYPES[card.cardType]?.label : '')
    for (const det of card.details ?? []) hay.push(`${det.name}: ${det.value}`, det.value)
  }
  return hay.some(h => (h ?? '').toLowerCase().includes(n))
}

type Ctx = {
  sceneId: string
  s: number
  groups: ProjectGroup[]
  boards: ReturnType<typeof useBoardsStore.getState>['boards']
  where: () => { x: number; y: number }
  write: (next: SceneDiv) => void
  root: () => SceneDiv | undefined
  picked: string | null
  pick: (id: string | null) => void
  linking: boolean
  renaming: string | null
  setRenaming: (id: string | null) => void
  writing: string | null
  setWriting: (id: string | null) => void
  lit: Set<string> | null
  bumps: boolean
  focus: boolean
  toggleFocus: (id: string) => void
}

/** A click (the card did not move between press and release). */
function useClick(ctx: Ctx, onClick: (e: React.MouseEvent) => void) {
  const down = useRef<{ x: number; y: number } | null>(null)
  return {
    onPointerDown: (e: React.PointerEvent) => { if (e.button === 0) down.current = ctx.where() },
    onClick: (e: React.MouseEvent) => {
      const a = down.current, b = ctx.where()
      down.current = null
      if (e.button !== 0 || !a || Math.hypot(a.x - b.x, a.y - b.y) > 0.5) return
      onClick(e)
    },
  }
}

const NameInput: React.FC<{ d: SceneDiv; ctx: Ctx; font: number }> = ({ d, ctx, font }) => {
  const [draft, setDraft] = useState(d.name ?? '')
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => { requestAnimationFrame(() => { ref.current?.focus(); ref.current?.select() }) }, [])
  const commit = () => {
    if (done.current) return
    done.current = true
    const r = ctx.root()
    if (r && draft !== d.name) ctx.write(patchDiv(r, d.id, { name: draft }))
    ctx.setRenaming(null)
  }
  return (
    <input
      ref={ref}
      data-scene-name-input
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onPointerDown={stopPress}
      onDoubleClick={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') { e.preventDefault(); commit() }
        else if (e.key === 'Escape') { e.preventDefault(); done.current = true; ctx.setRenaming(null) }
      }}
      onBlur={commit}
      style={{
        fontSize: font, fontWeight: 700, color: '#fff', textAlign: 'center', width: '86%', minWidth: 0, boxSizing: 'border-box',
        padding: '0 1px', margin: 0, fontFamily: 'inherit', background: 'rgba(0,0,0,0.45)', border: '0.5px solid rgba(255,255,255,0.6)',
        borderRadius: 1.5, outline: 'none', userSelect: 'text', pointerEvents: 'auto',
      }}
    />
  )
}

const NotesInput: React.FC<{ d: SceneDiv; ctx: Ctx; font: number }> = ({ d, ctx, font }) => {
  const [draft, setDraft] = useState(d.notes ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)
  useEffect(() => { requestAnimationFrame(() => { const t = ref.current; if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length) } }) }, [])
  const commit = () => {
    if (done.current) return
    done.current = true
    const r = ctx.root()
    if (r && draft !== (d.notes ?? '')) ctx.write(patchDiv(r, d.id, { notes: draft }))
    ctx.setWriting(null)
  }
  return (
    <textarea
      ref={ref}
      data-scene-notes-input
      value={draft}
      placeholder="Notes"
      onChange={e => setDraft(e.target.value)}
      onPointerDown={stopPress}
      onDoubleClick={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); commit() }
      }}
      onBlur={commit}
      style={{
        position: 'absolute', inset: 1, resize: 'none', boxSizing: 'border-box', padding: 1.5, margin: 0, zIndex: 4,
        fontSize: font, lineHeight: 1.25, color: '#fff', textAlign: 'center', fontFamily: 'inherit',
        background: 'rgba(0,0,0,0.45)', border: '0.5px solid rgba(255,255,255,0.6)', borderRadius: 1.5, outline: 'none', userSelect: 'text',
      }}
    />
  )
}

const Division: React.FC<{ d: SceneDiv; box: Box; ctx: Ctx }> = ({ d, box, ctx }) => {
  const cardId = heldCard(d)
  const card = cardId ? ctx.groups.find(g => g.id === cardId) : undefined
  const face = card ? cardFaceMedia(card, ctx.boards) : null
  const pic = face?.type === 'image' ? face.url : face?.posterUrl ?? null
  // Short, and something to line up after its name: one row. A bare
  // strip (a heading) stays a centred label.
  const row = box.h < ROW_H && (!!heldCard(d) || !!(d.notes ?? '').trim())
  const nameFont = row ? clamp(box.h * 0.46, 3, 6.5) : clamp(Math.min(box.h < ROW_H ? box.h * 0.55 : box.h * 0.26, box.w * 0.11), 3, 11)
  const smallFont = clamp(nameFont * 0.62, 2.6, 7)
  const textFont = clamp(nameFont * 0.68, 3, 9)
  const mid = d.mid !== false
  const bump = ctx.bumps && !!d.bump
  const lift = bump ? Math.min(box.h * 0.22, 7) : 0
  const faded = ctx.lit && !ctx.lit.has(d.id)
  const picked = ctx.picked === d.id
  const opened = !!d.opens && ctx.groups.some(g => g.id === d.opens)
  const tabColor = card?.color ?? d.color ?? '#5b8dd9'
  const tabH = clamp(nameFont * 1.25, 4, 9)
  const click = useClick(ctx, () => {
    if (ctx.focus) ctx.toggleFocus(d.id)
    ctx.pick(d.id)
  })
  const nameClick = useClick(ctx, e => {
    if (!picked || ctx.focus) return
    e.stopPropagation()
    ctx.setRenaming(d.id)
  })
  const label = d.name ?? ''
  const shadow = '0 0.5px 1.5px rgba(0,0,0,0.75)'
  const nameEl = ctx.renaming === d.id
    ? <NameInput d={d} ctx={ctx} font={nameFont} />
    : label
      ? <span data-scene-name={d.id} {...nameClick} style={{ cursor: picked ? 'text' : undefined, pointerEvents: 'auto' }}>{label}</span>
      : null
  const title = card ? cardTitle(ctx.groups, card) : ''
  const mainText = card ? (card.cardText ?? '').trim() : (d.notes ?? '').trim()

  return (
    <div
      data-scene-div={d.id}
      data-link-drop={`division:${ctx.sceneId}:${d.id}`}
      {...click}
      onDoubleClick={e => {
        e.stopPropagation()
        if (!card && !ctx.focus) ctx.setWriting(d.id)
      }}
      style={{
        position: 'absolute', left: box.x, top: box.y - lift, width: box.w, height: box.h + lift, zIndex: bump ? 3 : picked ? 2 : 1,
        filter: faded ? 'grayscale(0.85) brightness(0.5)' : undefined, opacity: faded ? 0.75 : 1, transition: 'filter 0.18s, opacity 0.18s',
      }}
    >
      {/* The box: colour, the card's picture filling it. */}
      <div style={{
        position: 'absolute', inset: 0, borderRadius: 2.2, overflow: 'hidden', background: card && !pic ? card.color : d.color ?? '#5b8dd9',
        boxShadow: bump ? '0 1px 3px rgba(0,0,0,0.55)' : undefined,
        outline: picked ? '0.8px solid #fff' : ctx.linking ? '0.6px dashed rgba(255,255,255,0.85)' : bump ? '0.5px solid rgba(255,255,255,0.55)' : undefined,
        outlineOffset: picked || ctx.linking ? -0.8 : -0.5,
      }}>
        {pic && !row && (
          <img src={pic} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }} />
        )}
        {pic && !row && mid && label && (
          // Lets the middle label read over a picture.
          <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at center, rgba(0,0,0,0.32), rgba(0,0,0,0) 70%)', pointerEvents: 'none' }} />
        )}
        {row ? (
          // One row: round picture, the name, the main text.
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', gap: 1.5, padding: '0 2px', boxSizing: 'border-box', overflow: 'hidden', color: '#fff', textShadow: shadow, pointerEvents: 'none' }}>
            {card && (
              <div style={{
                flex: '0 0 auto', width: box.h * 0.78, height: box.h * 0.78, borderRadius: '50%', overflow: 'hidden',
                background: card.color, border: '0.5px solid rgba(255,255,255,0.8)', boxSizing: 'border-box',
              }}>
                {pic && <img src={pic} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
              </div>
            )}
            {mid && nameEl && <span style={{ flex: '0 1 auto', fontSize: nameFont, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{nameEl}</span>}
            {card && <span style={{ flex: '0 1 auto', fontSize: nameFont, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, opacity: 0.95 }}>{title}</span>}
            {mainText && <span style={{ flex: '1 1 0', fontSize: textFont * 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, opacity: 0.9 }}>{mainText}</span>}
          </div>
        ) : (<>
          {/* The middle label, and an empty division's notes under it. */}
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: 2, boxSizing: 'border-box', color: '#fff', textAlign: 'center', overflow: 'hidden', pointerEvents: 'none', gap: 1,
          }}>
            {mid && nameEl && <div style={{ fontSize: nameFont, fontWeight: 700, lineHeight: 1.1, textShadow: shadow, maxWidth: '100%', overflowWrap: 'anywhere' }}>{nameEl}</div>}
            {!card && d.notes && ctx.writing !== d.id && (
              <div data-scene-notes style={{ fontSize: textFont, lineHeight: 1.25, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', textShadow: shadow, maxWidth: '100%', opacity: 0.95 }}>{d.notes}</div>
            )}
            {card && !pic && card.cardText && (
              <div style={{ fontSize: textFont, lineHeight: 1.25, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', textShadow: shadow, maxWidth: '100%', opacity: 0.95 }}>{card.cardText}</div>
            )}
          </div>
          {/* The card it holds: its name and type, top-left. */}
          {card && (
            <div data-scene-card={card.id} title={title} style={{
              position: 'absolute', left: 1.2, top: 1.2, maxWidth: d.tab ? '46%' : '80%', display: 'flex', alignItems: 'center', gap: 1,
              padding: '0.4px 1.6px 0.4px 1px', borderRadius: 1.5, background: card.color, color: '#fff', boxShadow: '0 0.5px 1px rgba(0,0,0,0.4)',
              fontSize: smallFont, fontWeight: 700, lineHeight: 1.15, pointerEvents: 'none',
            }}>
              <span style={{ flex: '0 0 auto', width: smallFont * 0.7, height: smallFont * 0.7, borderRadius: '50%', background: 'rgba(255,255,255,0.85)' }}
                title={card.cardType ? CARD_TYPES[card.cardType]?.label : 'Element'} />
              <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{title}</span>
            </div>
          )}
          {ctx.writing === d.id && <NotesInput d={d} ctx={ctx} font={textFont} />}
        </>)}
        {opened && (
          // It has its own scene card: lit; a click goes there.
          <button type="button" data-scene-opened title="Go to its scene card" onPointerDown={stopPress}
            onClick={e => { e.stopPropagation(); openDivision(ctx.sceneId, d.id) }}
            style={{
              position: 'absolute', right: 1, bottom: 1, width: 6, height: 6, padding: 0, border: '0.5px solid #fff', borderRadius: 1.2,
              background: 'rgba(255,214,102,0.95)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3,
            }}>
            <OpenIcon size={4.4} color="#000" />
          </button>
        )}
      </div>
      {/* The tab: a small label stuck to the top-right edge, in the colour
          of the card it holds. */}
      {d.tab && (label || title) && (
        <div data-scene-tab style={{
          position: 'absolute', right: 2.5, top: -tabH * 0.55, height: tabH, maxWidth: '46%', padding: `0 ${tabH * 0.35}px`,
          display: 'flex', alignItems: 'center', borderRadius: `${tabH * 0.3}px ${tabH * 0.3}px ${tabH * 0.2}px ${tabH * 0.2}px`,
          background: tabColor, color: '#fff', fontSize: tabH * 0.62, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden',
          textOverflow: 'ellipsis', boxShadow: '0 0.5px 1.5px rgba(0,0,0,0.5)', border: '0.4px solid rgba(255,255,255,0.6)', boxSizing: 'border-box',
          zIndex: 4, pointerEvents: 'none',
        }}>{label || title}</div>
      )}
    </div>
  )
}

const OpenIcon: React.FC<{ size: number; color: string }> = ({ size, color }) => (
  <svg width={size} height={size} viewBox="0 0 8 8"><rect x="0.5" y="2.5" width="5" height="5" fill="none" stroke={color} strokeWidth="1" /><path d="M4 0.5h3.5V4M7.5 0.5L3.5 4.5" fill="none" stroke={color} strokeWidth="1" /></svg>
)

/** The line between two parts of a split: drag it to share the space
 *  between them differently. */
const Seam: React.FC<{ split: SceneDiv; i: number; box: Box; room: number; ctx: Ctx }> = ({ split, i, box, room, ctx }) => {
  const row = split.dir === 'row'
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    // A pointer move in flat screen px, divided by the face's scale, is a
    // move in layout units.
    const sizes = split.sizes ?? split.kids!.map(() => 1 / split.kids!.length)
    const a0 = sizes[i], b0 = sizes[i + 1]
    const start = row ? e.clientX : e.clientY
    useUndoCoordinator.getState().checkpoint()
    const MIN = 0.02
    const onMove = (ev: PointerEvent) => {
      const d = ((row ? ev.clientX : ev.clientY) - start) / ctx.s / Math.max(1, room)
      const a = Math.max(MIN, Math.min(a0 + b0 - MIN, a0 + d))
      const r = ctx.root()
      if (r) useBoardsStore.getState().setGroupScene(ctx.sceneId, resizeSplit(r, split.id, i, a, a0 + b0 - a))
    }
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const reach = GAP + 1.6
  return (
    <div
      data-scene-seam={`${split.id}:${i}`}
      onPointerDown={onDown}
      onDoubleClick={e => e.stopPropagation()}
      style={{
        position: 'absolute', zIndex: 5, cursor: row ? 'col-resize' : 'row-resize',
        ...(row
          ? { left: box.x + box.w - (reach - GAP) / 2, top: box.y, width: reach, height: box.h }
          : { left: box.x, top: box.y + box.h - (reach - GAP) / 2, width: box.w, height: reach }),
      }}
    />
  )
}

/** A switch on the bar: lit while on; its label never changes. */
const Toggle: React.FC<{ on: boolean; title: string; tool: string; onClick: () => void; children: React.ReactNode }> = ({ on, title, tool, onClick, children }) => (
  <button
    type="button"
    data-scene-tool={tool}
    title={title}
    onPointerDown={stopPress}
    onDoubleClick={e => e.stopPropagation()}
    onClick={e => { e.stopPropagation(); onClick() }}
    style={{
      height: 16, minWidth: 16, padding: '0 4px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
      fontSize: 9.5, lineHeight: 1, fontWeight: 600, borderRadius: 3, cursor: 'pointer', whiteSpace: 'nowrap',
      color: on ? '#111' : '#e6e9ef', background: on ? '#ffd666' : 'rgba(255,255,255,0.08)',
      border: on ? '1px solid #ffd666' : '1px solid rgba(255,255,255,0.22)', fontFamily: 'inherit',
    }}
  >{children}</button>
)

const Sep = () => <span style={{ width: 1, alignSelf: 'stretch', background: 'rgba(255,255,255,0.2)', margin: '0 2px' }} />

export const SceneFace: React.FC<{
  group: ProjectGroup; width: number; height: number
  /** Kept for the card's call; the face now runs to the top (its buttons
   *  show over the first division on hover). */
  reserve?: number
}> = ({ group, width, height }) => {
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const linking = useLinkDragStore(s => s.active && s.source?.kind === 'group' && s.source.id !== group.id)
  const [hover, setHover] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [writing, setWriting] = useState<string | null>(null)
  const [picker, setPicker] = useState<{ id: string; x: number; y: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const scene = group.scene
  const view: SceneView = group.sceneView ?? {}

  // A press anywhere off this face (or Esc) lets the picked division go.
  useEffect(() => {
    if (!picked) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (rootRef.current && t && rootRef.current.contains(t)) return
      if ((t as HTMLElement | null)?.closest?.('[data-color-picker]')) return
      setPicked(null)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPicked(null) }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey) }
  }, [picked])

  const lit = useMemo(() => {
    if (!scene) return null
    const sets: Set<string>[] = []
    if (view.focus) { const l = litDivisions(scene, view.picked ?? []); if (l) sets.push(l) }
    if (view.trace && (view.traceText ?? '').trim()) {
      const hits = leaves(scene).filter(d => {
        const c = heldCard(d)
        return traceMatch(d, c ? groups.find(g => g.id === c) : undefined, groups, view.traceText ?? '')
      }).map(d => d.id)
      sets.push(litDivisions(scene, hits) ?? new Set())
    }
    if (!sets.length) return null
    // Both on: lit by both.
    return sets.reduce((a, b) => new Set([...a].filter(x => b.has(x))))
  }, [scene, view.focus, view.picked, view.trace, view.traceText, groups])

  if (!scene) return null
  const s = Math.max(0.01, Math.min(width / NAT_W, height / NAT_H))
  const W = width / s, H = height / s
  const iw = W - PAD * 2, ih = H - PAD * 2
  const boxes = divBoxes(scene, iw, ih, GAP)
  const root = () => useBoardsStore.getState().groups.find(g => g.id === group.id)?.scene
  const setView = (patch: Partial<SceneView>) => {
    useUndoCoordinator.getState().checkpoint()
    const g = useBoardsStore.getState().groups.find(gr => gr.id === group.id)
    useBoardsStore.getState().setGroupSceneView(group.id, { ...(g?.sceneView ?? {}), ...patch })
  }
  const ctx: Ctx = {
    sceneId: group.id, s, groups, boards, linking, renaming, setRenaming, writing, setWriting,
    picked, pick: setPicked, lit, bumps: view.bumps !== false, focus: !!view.focus,
    toggleFocus: id => {
      const cur = view.picked ?? []
      setView({ picked: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id] })
    },
    where: () => {
      const g = useBoardsStore.getState().groups.find(gr => gr.id === group.id)
      return { x: g?.originX ?? 0, y: g?.originY ?? 0 }
    },
    root,
    write: next => { useUndoCoordinator.getState().checkpoint(); useBoardsStore.getState().setGroupScene(group.id, next) },
  }

  // Leaves and seams, laid out absolutely from the tree.
  const parts: React.ReactNode[] = []
  const walk = (d: SceneDiv) => {
    const b = boxes.get(d.id)
    if (!b) return
    if (isLeaf(d)) { parts.push(<Division key={d.id} d={d} box={b} ctx={ctx} />); return }
    const n = d.kids!.length
    const room = (d.dir === 'row' ? b.w : b.h) - GAP * (n - 1)
    d.kids!.forEach((k, i) => {
      walk(k)
      if (i < n - 1) parts.push(<Seam key={`${d.id}:${i}`} split={d} i={i} box={boxes.get(k.id)!} room={room} ctx={ctx} />)
    })
  }
  walk(scene)

  const sel = picked ? findDiv(scene, picked) : null
  const selLeaf = sel && isLeaf(sel) ? sel : null
  const canRemove = leaves(scene).length > 1
  const edit = (fn: (r: SceneDiv) => SceneDiv) => { const r = root(); if (r) ctx.write(fn(r)) }
  const pickedColor = picker ? leaves(scene).find(l => l.id === picker.id)?.color ?? '#5b8dd9' : '#5b8dd9'
  const showBar = (hover || !!selLeaf) && !linking

  return (
    <div
      ref={rootRef}
      data-scene-face={group.id}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: '0 0 12px 12px' }}
    >
      <div style={{
        position: 'absolute', left: 0, top: 0, width: W, height: H,
        transform: `scale(${s})`, transformOrigin: '0 0', fontFamily: 'inherit',
      }}>
        <div style={{ position: 'absolute', left: PAD, top: PAD, width: iw, height: ih }}>
          {parts}
        </div>
      </div>
      {showBar && (
        // The bar: the scene's view modes, then the picked division's tools.
        <div
          data-scene-bar
          onPointerDown={stopPress}
          onDoubleClick={e => e.stopPropagation()}
          onWheel={e => e.stopPropagation()}
          style={{
            position: 'absolute', left: 4, right: 4, bottom: 4, zIndex: 20, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 3,
            padding: 3, borderRadius: 5, background: 'rgba(16,18,26,0.88)', border: '1px solid rgba(255,255,255,0.14)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.5)', cursor: 'default',
          }}
        >
          <Toggle tool="view-focus" on={!!view.focus} title="Focus: click divisions to light them (a section's heading lights the section); the rest fade" onClick={() => setView({ focus: !view.focus })}>Focus</Toggle>
          <Toggle tool="view-bumps" on={view.bumps !== false} title="Bump-outs: divisions marked Bump stand taller" onClick={() => setView({ bumps: view.bumps === false })}>Bump-outs</Toggle>
          <Toggle tool="view-trace" on={!!view.trace} title="Trace: only divisions whose card or text matches stay lit" onClick={() => setView({ trace: !view.trace })}>Trace</Toggle>
          {view.trace && (
            <input
              data-scene-trace
              value={view.traceText ?? ''}
              placeholder="prop, Budget: high…"
              onChange={e => useBoardsStore.getState().setGroupSceneView(group.id, { ...view, traceText: e.target.value })}
              onKeyDown={e => e.stopPropagation()}
              onPointerDown={stopPress}
              style={{
                height: 16, width: 96, boxSizing: 'border-box', padding: '0 4px', fontSize: 9.5, color: '#fff', fontFamily: 'inherit',
                background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 3, outline: 'none', userSelect: 'text',
              }}
            />
          )}
          {view.focus && (view.picked?.length ?? 0) > 0 && (
            <Toggle tool="view-focus-clear" on={false} title="Light every division again" onClick={() => setView({ picked: [] })}>Clear</Toggle>
          )}
          {selLeaf && (<>
            <Sep />
            <Toggle tool="split-row" on={false} title="Divide it side by side" onClick={() => edit(r => splitDiv(r, selLeaf.id, 'row'))}>
              <svg width="9" height="9" viewBox="0 0 8 8"><rect x="0.5" y="0.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" /><line x1="4" y1="0.5" x2="4" y2="7.5" stroke="currentColor" strokeWidth="1" /></svg>
            </Toggle>
            <Toggle tool="split-col" on={false} title="Divide it top and bottom" onClick={() => edit(r => splitDiv(r, selLeaf.id, 'col'))}>
              <svg width="9" height="9" viewBox="0 0 8 8"><rect x="0.5" y="0.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1" /><line x1="0.5" y1="4" x2="7.5" y2="4" stroke="currentColor" strokeWidth="1" /></svg>
            </Toggle>
            <button type="button" data-scene-tool="color" title="Colour" onPointerDown={stopPress}
              onClick={e => { e.stopPropagation(); setPicker({ id: selLeaf.id, x: e.clientX, y: e.clientY }) }}
              style={{ width: 16, height: 16, padding: 0, borderRadius: 3, cursor: 'pointer', background: selLeaf.color ?? '#5b8dd9', border: '1px solid rgba(255,255,255,0.5)' }} />
            <Toggle tool="label-mid" on={selLeaf.mid !== false} title="Name in the middle" onClick={() => edit(r => patchDiv(r, selLeaf.id, { mid: selLeaf.mid === false }))}>Middle</Toggle>
            <Toggle tool="label-tab" on={!!selLeaf.tab} title="Name on a tab at the top-right edge" onClick={() => edit(r => patchDiv(r, selLeaf.id, { tab: !selLeaf.tab }))}>Tab</Toggle>
            <Toggle tool="bump" on={!!selLeaf.bump} title="Bump out: stands taller than its slot" onClick={() => edit(r => patchDiv(r, selLeaf.id, { bump: !selLeaf.bump }))}>Bump</Toggle>
            {/* Making the card takes the undo checkpoint (createCardOrBoardAt). */}
            <Toggle tool="open" on={!!selLeaf.opens && groups.some(g => g.id === selLeaf.opens)} title="Open as its own scene card (lit: it has one; click goes there)" onClick={() => openDivision(group.id, selLeaf.id)}>
              <OpenIcon size={9} color="currentColor" /> Open
            </Toggle>
            {heldCard(selLeaf) && (
              <Toggle tool="take-out" on={false} title="Take the card out of this division" onClick={() => edit(r => takeCard(r, selLeaf.id))}>Take out</Toggle>
            )}
            {canRemove && (
              <Toggle tool="remove" on={false} title="Remove this division (its neighbour takes the space)" onClick={() => {
                edit(r => removeDiv(r, selLeaf.id))
                setPicked(null)
              }}>×</Toggle>
            )}
          </>)}
        </div>
      )}
      {picker && ReactDOM.createPortal(
        <div data-color-picker>
          <ColorPickerPopup
            color={pickedColor}
            anchorX={picker.x}
            anchorY={picker.y}
            onChange={c => { const r = root(); if (r) { useUndoCoordinator.getState().checkpoint(); useBoardsStore.getState().setGroupScene(group.id, patchDiv(r, picker.id, { color: c })) } }}
            onClose={() => setPicker(null)}
          />
        </div>,
        document.body,
      )}
    </div>
  )
}
