// A SCENE card's face (Brian's storyMap): its divisions, coloured, filling
// the face as a media sheet (Brian 2026-11-07): tight gaps. A division
// without a face shows its name in the middle. A card let go on it copies
// that card's face in (header, text, picture and their look, utils/
// sceneContent), and from then on the division's face is drawn and edited
// exactly as a card's is (GroupCardText, its toolbar: fonts, spacing,
// split...), never touching the card, which it only links back to (a small
// icon while pointed at). Double-click a division to write in it the same
// way. A division made short drops to one row: round picture, header, text.
//
// Click a division to pick it: the bar along the face's bottom holds its
// tools (divide, colour, bump out, open as its own scene card, move or take
// off the picture, unlink, remove) and the scene's view modes: Focus (click
// divisions to light them, a section's heading lights the section),
// Bump-outs (marked divisions stand taller), Trace (only divisions whose
// card or text matches stay lit, with the headings on the path to them).
// Drag the line between two to resize them. Data: ProjectGroup.scene /
// sceneView (utils/sceneCard).

import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useLinkDragStore } from '../../store/linkDragStore'
import { cardTitle } from '../../utils/faceStyle'
import { CARD_TYPES } from '../../utils/cardTypes'
import {
  divBoxes, findDiv, heldCard, isLeaf, leaves, litDivisions, patchDiv, removeDiv, resizeSplit, splitDiv, takeCard,
  type SceneDiv, type SceneView,
} from '../../utils/sceneCard'
import { GroupCardText } from './CardLayer'
import { openDivision } from '../../utils/sceneOpen'
import { cardChanged, migrateScene, refreshDivision } from '../../utils/sceneContent'
import { useCanvasStore } from '../../store/canvasStore'
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
  hovered: string | null
  setHovered: (id: string | null) => void
  moving: string | null
  setMoving: (id: string | null) => void
  /** Change a division (with an undo step unless step is false). */
  patch: (id: string, p: Partial<SceneDiv>, step?: boolean) => void
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

const Division: React.FC<{ d: SceneDiv; box: Box; ctx: Ctx }> = ({ d, box, ctx }) => {
  const srcId = heldCard(d)
  const src = srcId ? ctx.groups.find(g => g.id === srcId) : undefined
  const pic = d.image ?? null
  const crop = d.crop ?? { x: 50, y: 50, z: 1 }
  const header = d.name ?? ''
  const text = (d.notes ?? '').trim()
  // Short, and something to line up after its header: one row. A bare
  // strip (a heading) stays a centred label.
  const row = box.h < ROW_H && (!!pic || !!text)
  const hs = d.hs ?? 1, ts = d.ts ?? 1
  const nameFont = (row ? clamp(box.h * 0.46, 3, 6.5) : clamp(Math.min(box.h < ROW_H ? box.h * 0.55 : box.h * 0.26, box.w * 0.11), 3, 11)) * hs
  const textFont = clamp(nameFont / hs * 0.68, 3, 9) * ts
  const bump = ctx.bumps && !!d.bump
  const lift = bump ? Math.min(box.h * 0.22, 7) : 0
  const faded = ctx.lit && !ctx.lit.has(d.id)
  const picked = ctx.picked === d.id
  const hovered = ctx.hovered === d.id
  const moving = ctx.moving === d.id && !!pic
  const opened = !!d.opens && ctx.groups.some(g => g.id === d.opens)
  const changed = cardChanged(d, src)
  const click = useClick(ctx, () => {
    if (ctx.focus) ctx.toggleFocus(d.id)
    ctx.pick(d.id)
  })
  const nameClick = useClick(ctx, e => {
    if (!picked || ctx.focus) return
    e.stopPropagation()
    ctx.setRenaming(d.id)
  })
  const shadow = '0 0.5px 1.5px rgba(0,0,0,0.75)'
  const nameEl = ctx.renaming === d.id
    ? <NameInput d={d} ctx={ctx} font={nameFont} />
    : header
      ? <span data-scene-name={d.id} {...nameClick} style={{ cursor: picked ? 'text' : undefined, pointerEvents: 'auto' }}>{header}</span>
      : null

  // Move picture: drag the picture about inside the box, wheel zooms it.
  const onMoveDown = (e: React.PointerEvent) => {
    if (!moving || e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY }, c0 = { ...crop }
    useUndoCoordinator.getState().checkpoint()
    const onMove = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / ctx.s / Math.max(1, box.w) * 100 / c0.z
      const dy = (ev.clientY - start.y) / ctx.s / Math.max(1, box.h) * 100 / c0.z
      const r = ctx.root()
      if (r) useBoardsStore.getState().setGroupScene(ctx.sceneId, patchDiv(r, d.id, { crop: { ...c0, x: clamp(c0.x - dx, 0, 100), y: clamp(c0.y - dy, 0, 100) } }))
    }
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  const onWheel = (e: React.WheelEvent) => {
    if (!moving) return
    e.stopPropagation()
    const r = ctx.root()
    if (r) useBoardsStore.getState().setGroupScene(ctx.sceneId, patchDiv(r, d.id, { crop: { ...crop, z: clamp(crop.z * (e.deltaY < 0 ? 1.08 : 1 / 1.08), 1, 6) } }))
  }

  return (
    <div
      data-scene-div={d.id}
      data-link-drop={`division:${ctx.sceneId}:${d.id}`}
      {...click}
      onPointerDownCapture={onMoveDown}
      onWheel={onWheel}
      onPointerEnter={() => ctx.setHovered(d.id)}
      onPointerLeave={() => ctx.setHovered(null)}
      onDoubleClick={e => {
        e.stopPropagation()
        if (ctx.focus || moving) return
        // Write in it as on a card: it gets a face of its own (its name the
        // header) and its header opens for typing, with the toolbar.
        if (!d.face) ctx.patch(d.id, { face: true }, true)
        const el = e.currentTarget as HTMLElement
        requestAnimationFrame(() => el.querySelector('[data-card-text]')?.dispatchEvent(new CustomEvent('start-edit', { bubbles: false })))
      }}
      style={{
        position: 'absolute', left: box.x, top: box.y - lift, width: box.w, height: box.h + lift, zIndex: bump ? 3 : picked ? 2 : 1,
        filter: faded ? 'grayscale(0.85) brightness(0.5)' : undefined, opacity: faded ? 0.75 : 1, transition: 'filter 0.18s, opacity 0.18s',
        cursor: moving ? 'move' : undefined,
      }}
    >
      {/* The box: its colour, its picture filling it. */}
      <div style={{
        position: 'absolute', inset: 0, borderRadius: 2.2, overflow: 'hidden', background: d.color ?? '#5b8dd9',
        boxShadow: bump ? '0 1px 3px rgba(0,0,0,0.55)' : undefined,
        outline: moving ? '0.8px dashed #ffd666' : picked ? '0.8px solid #fff' : ctx.linking ? '0.6px dashed rgba(255,255,255,0.85)' : bump ? '0.5px solid rgba(255,255,255,0.55)' : undefined,
        outlineOffset: picked || ctx.linking || moving ? -0.8 : -0.5,
      }}>
        {pic && !row && (
          <img src={pic} alt="" draggable={false} data-scene-pic style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none',
            objectPosition: `${crop.x}% ${crop.y}%`, transformOrigin: `${crop.x}% ${crop.y}%`, opacity: d.hero?.opacity ?? 1,
            transform: `scale(${crop.z * (d.hero?.flipH ? -1 : 1)}, ${crop.z * (d.hero?.flipV ? -1 : 1)})`,
          }} />
        )}
        {row ? (
          // One row: round picture, the header, the text.
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', gap: 1.5, padding: '0 2px', boxSizing: 'border-box', overflow: 'hidden', color: '#fff', textShadow: shadow, pointerEvents: 'none' }}>
            {pic && (
              <div style={{
                flex: '0 0 auto', width: box.h * 0.78, height: box.h * 0.78, borderRadius: '50%', overflow: 'hidden',
                border: '0.5px solid rgba(255,255,255,0.8)', boxSizing: 'border-box',
              }}>
                <img src={pic} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: `${crop.x}% ${crop.y}%` }} />
              </div>
            )}
            {nameEl && <span style={{ flex: '0 1 auto', fontSize: nameFont, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{nameEl}</span>}
            {text && <span style={{ flex: '1 1 0', fontSize: textFont * 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, opacity: 0.9 }}>{text}</span>}
          </div>
        ) : d.face ? (
          // Its own card face: drawn and edited as a card's is, with the
          // same toolbar (fonts, spacing, split...). Never the card's.
          <GroupCardText groupId={ctx.sceneId} heroImage={pic} onCropImage={() => { ctx.pick(d.id); ctx.setMoving(d.id) }} bind={{
            header, body: d.notes ?? '', headerStyle: d.hstyle, bodyStyle: d.bstyle, split: d.split, hero: d.hero,
            scale: clamp(Math.min(box.w / NAT_W, box.h / (NAT_H * 0.5)), 0.12, 2.5),
            setHeader: v => ctx.patch(d.id, { name: v }),
            setBody: v => ctx.patch(d.id, { notes: v }),
            setHeaderStyle: st => ctx.patch(d.id, { hstyle: st }, true),
            setBodyStyle: st => ctx.patch(d.id, { bstyle: st }, true),
            setSplit: r => ctx.patch(d.id, { split: r }, false),
            setHero: h => ctx.patch(d.id, { hero: h }, false),
          }} />
        ) : (
          // No face yet: its name, in the middle.
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
            padding: 2, boxSizing: 'border-box', color: '#fff', textAlign: 'center', overflow: 'hidden', pointerEvents: 'none', gap: 1,
          }}>
            {nameEl && <div style={{ fontSize: nameFont, fontWeight: 700, lineHeight: 1.1, textShadow: shadow, maxWidth: '100%', overflowWrap: 'anywhere' }}>{nameEl}</div>}
            {text && <div data-scene-notes style={{ fontSize: textFont, lineHeight: 1.25, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', textShadow: shadow, maxWidth: '100%', opacity: 0.95 }}>{d.notes}</div>}
          </div>
        )}
        {changed && (
          // The card it came from changed since: a small mark; a click
          // takes the new content (its look and crop stay).
          <button type="button" data-scene-refresh title="The card this came from changed: take its new header, text and picture" onPointerDown={stopPress}
            onClick={e => { e.stopPropagation(); useUndoCoordinator.getState().checkpoint(); refreshDivision(ctx.sceneId, d.id) }}
            style={{
              position: 'absolute', left: 1, top: 1, width: 5.5, height: 5.5, padding: 0, border: '0.4px solid #fff', borderRadius: '50%',
              background: 'rgba(255,214,102,0.95)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3,
            }}>
            <svg width="3.8" height="3.8" viewBox="0 0 8 8"><path d="M6.6 3.2A2.8 2.8 0 1 0 6.2 5.6" fill="none" stroke="#000" strokeWidth="1.2" /><path d="M7.4 0.8v2.8H4.6" fill="none" stroke="#000" strokeWidth="1.2" /></svg>
          </button>
        )}
        <div style={{ position: 'absolute', right: 1, bottom: 1, display: 'flex', gap: 1, zIndex: 3 }}>
          {src && hovered && !ctx.linking && (
            // Back to the card it came from: only while pointed at.
            <button type="button" data-scene-source title="Go to the card this came from" onPointerDown={stopPress}
              onClick={e => { e.stopPropagation(); goToCard(src.id) }}
              style={{
                width: 6, height: 6, padding: 0, border: '0.4px solid rgba(255,255,255,0.8)', borderRadius: 1.2, background: 'rgba(0,0,0,0.6)',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
              <svg width="4" height="4" viewBox="0 0 8 8"><path d="M3 1H1v6h6V5" fill="none" stroke="#fff" strokeWidth="1" /><path d="M4.5 0.8h2.7v2.7M7.2 0.8L3.6 4.4" fill="none" stroke="#fff" strokeWidth="1" /></svg>
            </button>
          )}
          {opened && (
            // It has its own scene card: lit; a click goes there.
            <button type="button" data-scene-opened title="Go to its scene card" onPointerDown={stopPress}
              onClick={e => { e.stopPropagation(); openDivision(ctx.sceneId, d.id) }}
              style={{
                width: 6, height: 6, padding: 0, border: '0.5px solid #fff', borderRadius: 1.2,
                background: 'rgba(255,214,102,0.95)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
              <OpenIcon size={4.4} color="#000" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Over to a card and select it (a card in a closed deck: its deck front). */
function goToCard(id: string) {
  useCanvasStore.getState().jumpToGroup(id)
  useBoardsStore.getState().setSelectedGroup(id)
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
  const [hoveredDiv, setHoveredDiv] = useState<string | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const [picker, setPicker] = useState<{ id: string; x: number; y: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const scene = group.scene
  const view: SceneView = group.sceneView ?? {}

  // Divisions holding a card from before faces were copied: copy now.
  useEffect(() => {
    if (!scene) return
    const next = migrateScene(scene)
    if (next) useBoardsStore.getState().setGroupScene(group.id, next)
  }, [scene, group.id])
  useEffect(() => { if (!picked) setMoving(null) }, [picked])

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
    picked, pick: id => { setPicked(id); if (id !== moving) setMoving(null) }, lit, hovered: hoveredDiv, setHovered: setHoveredDiv, moving, setMoving,
    patch: (id, p, step = true) => {
      const r = root()
      if (!r) return
      if (step) useUndoCoordinator.getState().checkpoint()
      useBoardsStore.getState().setGroupScene(group.id, patchDiv(r, id, p))
    }, bumps: view.bumps !== false, focus: !!view.focus,
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
            <Toggle tool="bump" on={!!selLeaf.bump} title="Bump out: stands taller than its slot" onClick={() => edit(r => patchDiv(r, selLeaf.id, { bump: !selLeaf.bump }))}>Bump</Toggle>
            {/* Making the card takes the undo checkpoint (createCardOrBoardAt). */}
            <Toggle tool="open" on={!!selLeaf.opens && groups.some(g => g.id === selLeaf.opens)} title="Open as its own scene card (lit: it has one; click goes there)" onClick={() => openDivision(group.id, selLeaf.id)}>
              <OpenIcon size={9} color="currentColor" /> Open
            </Toggle>
            <Sep />
            {selLeaf.image && (<>
              <Toggle tool="move-picture" on={moving === selLeaf.id} title="Move picture: drag it about in the division, wheel to zoom" onClick={() => setMoving(moving === selLeaf.id ? null : selLeaf.id)}>Move picture</Toggle>
              <Toggle tool="remove-picture" on={false} title="Take the picture off this division" onClick={() => { setMoving(null); edit(r => patchDiv(r, selLeaf.id, { image: undefined, crop: undefined })) }}>No picture</Toggle>
            </>)}
            {heldCard(selLeaf) && (
              <Toggle tool="unlink" on={false} title="Forget the card this came from (keeps what is on the division)" onClick={() => edit(r => takeCard(r, selLeaf.id))}>Unlink</Toggle>
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
