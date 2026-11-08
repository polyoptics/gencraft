// A SCENE card's face (Brian's storyMap): its divisions, coloured, filling
// the face as a media sheet. A division without a face shows its name in
// the middle. A card let go on it copies that card's face in (header, text,
// picture and their look, utils/sceneContent), and from then on the
// division's face is drawn and edited exactly as a card's is
// (GroupCardText, its toolbar), never touching the card, which it only
// links back to (a small icon while pointed at). Double-click a division to
// write in it the same way.
//
// Controls live on the divisions themselves (Brian 2026-11-08: "interactive
// with the widgets and zones", no bar): pointed at, a division shows a "+"
// on its right edge (divide side by side) and on its bottom edge (divide
// top and bottom), its colour and a "more" button (bump out, open as its
// own scene card, fold, picture, unlink, remove) at its top-right. A
// section's heading folds the section to one strip and opens it again.
// Drag the line between two to resize them.
//
// Each division shows itself by the room it has, and moves smoothly between
// them: its full face; an icon (round picture and its header); one row
// (round picture, header, text); a standing strip (its header on end).
//
// The scene's view modes sit in a small widget at its bottom-right: Focus
// (click divisions to light them, a section's heading lights the section),
// Bump-outs (marked divisions stand taller), Trace (only divisions whose
// card or text matches stay lit, with the headings on the path to them).
// Data: ProjectGroup.scene / sceneView (utils/sceneCard).

import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useLinkDragStore } from '../../store/linkDragStore'
import { cardTitle } from '../../utils/faceStyle'
import { CARD_TYPES } from '../../utils/cardTypes'
import {
  canFold, divBoxes, findDiv, heldCard, isLeaf, leaves, litDivisions, patchDiv, removeDiv, resizeSplit, sectionOf, shareUnits, splitDiv, takeCard,
  type SceneDiv, type SceneView,
} from '../../utils/sceneCard'
import { GroupCardText } from './CardLayer'
import { openDivision } from '../../utils/sceneOpen'
import { cardChanged, copyFrom, migrateScene, refreshDivision, shownContent } from '../../utils/sceneContent'
import { useCanvasStore } from '../../store/canvasStore'
import { ColorPickerPopup } from '../Bar/ColorPickerPopup'
import { area3dOutOf, toggleArea3d } from '../../utils/area3dCard'

/** Laid out at a new card's size and scaled with the card, like its back. */
const NAT_W = 125
const NAT_H = 184
// Card scale at which the layout reads at its natural size.
const SIZE_REF = 12
const GAP = 1.2
const PAD = 1.6
/** Shorter than this (layout units): one row. */
const ROW_H = 15
/** Narrower than this: a standing strip. */
const STAND_W = 14
/** Smaller than this, a division with a picture or face: an icon. */
const ICON_W = 36, ICON_H = 32
/** A division's controls, in screen px (the same size at every zoom). */
const TOOL_PX = 13

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const stopPress = (e: React.PointerEvent) => { if (e.button === 0) e.stopPropagation() }
type Box = { x: number; y: number; w: number; h: number }

/** Matches a trace: the card's name, type, text and details, or the
 *  division's own header and text. */
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
  /** A control's size in layout units. */
  u: number
  groups: ProjectGroup[]
  where: () => { x: number; y: number }
  write: (next: SceneDiv) => void
  root: () => SceneDiv | undefined
  picked: string | null
  pick: (id: string | null) => void
  linking: boolean
  renaming: string | null
  setRenaming: (id: string | null) => void
  /** The division whose notes are being typed into, in place. */
  noting: string | null
  setNoting: (id: string | null) => void
  lit: Set<string> | null
  bumps: boolean
  focus: boolean
  toggleFocus: (id: string) => void
  hovered: string | null
  setHovered: (id: string | null) => void
  moving: string | null
  setMoving: (id: string | null) => void
  /** A seam is being dragged: no easing, the divisions follow the hand. */
  dragging: boolean
  setDragging: (on: boolean) => void
  openMenu: (id: string, x: number, y: number) => void
  openPicker: (id: string, x: number, y: number) => void
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
        else if (e.key === 'Tab' && !d.face) { e.preventDefault(); commit(); ctx.setNoting(d.id) }
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

/** Typing a division's notes straight on the card: Enter makes a new
 *  line, Esc or a click away keeps them. */
const NotesInput: React.FC<{ d: SceneDiv; ctx: Ctx; font: number }> = ({ d, ctx, font }) => {
  const [draft, setDraft] = useState(d.notes ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  const done = useRef(false)
  useEffect(() => { requestAnimationFrame(() => { const el = ref.current; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length) } }) }, [])
  const commit = () => {
    if (done.current) return
    done.current = true
    const r = ctx.root()
    if (r && draft !== (d.notes ?? '')) ctx.write(patchDiv(r, d.id, { notes: draft }))
    ctx.setNoting(null)
  }
  return (
    <textarea
      ref={ref}
      data-scene-notes-input
      value={draft}
      rows={Math.max(1, draft.split('\n').length)}
      onChange={e => setDraft(e.target.value)}
      onPointerDown={stopPress}
      onDoubleClick={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); commit() }
        else if (e.key === 'Tab') { e.preventDefault(); commit(); if (e.shiftKey) ctx.setRenaming(d.id) }
      }}
      onBlur={commit}
      style={{
        fontSize: font, lineHeight: 1.25, color: '#fff', textAlign: 'center', width: '92%', minWidth: 0, boxSizing: 'border-box', resize: 'none',
        padding: '0 1px', margin: 0, fontFamily: 'inherit', background: 'rgba(0,0,0,0.35)', border: '0.5px solid rgba(255,255,255,0.6)',
        borderRadius: 1.5, outline: 'none', userSelect: 'text', pointerEvents: 'auto', overflow: 'hidden',
      }}
    />
  )
}

/** A round control on a division, sized in screen px. */
const Knob: React.FC<{
  ctx: Ctx; tool: string; title: string; at: React.CSSProperties; lit?: boolean; bg?: string
  onClick: (e: React.MouseEvent) => void; children?: React.ReactNode
}> = ({ ctx, tool, title, at, lit, bg, onClick, children }) => (
  <button
    type="button"
    data-scene-tool={tool}
    title={title}
    onPointerDown={stopPress}
    onDoubleClick={e => e.stopPropagation()}
    onClick={e => { e.stopPropagation(); onClick(e) }}
    style={{
      position: 'absolute', ...at, width: ctx.u, height: ctx.u, padding: 0, borderRadius: '50%', cursor: 'pointer', zIndex: 6,
      display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
      background: bg ?? (lit ? '#ffd666' : 'rgba(14,16,24,0.82)'), color: lit ? '#111' : '#fff',
      border: `${ctx.u * 0.08}px solid rgba(255,255,255,${lit ? 1 : 0.75})`, boxShadow: `0 ${ctx.u * 0.08}px ${ctx.u * 0.25}px rgba(0,0,0,0.45)`,
      fontSize: ctx.u * 0.72, fontWeight: 800, lineHeight: 1, fontFamily: 'inherit',
    }}
  >{children}</button>
)

const Glyph: React.FC<{ ctx: Ctx; d: string }> = ({ ctx, d }) => (
  <svg width={ctx.u * 0.6} height={ctx.u * 0.6} viewBox="0 0 10 10"><path d={d} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
)
const PLUS = 'M5 1.5v7M1.5 5h7'
const MORE = 'M2 5h0.01M5 5h0.01M8 5h0.01'
const FOLD = 'M2 3.5h6M2 6.5h6'

/** The largest font (layout units) at which the longest word of `t` fits
 *  in `w`. */
const wordFit = (t: string, w: number) => {
  const longest = t.split(/\s+/).reduce((m, x) => Math.max(m, x.length), 1)
  return Math.max(0, w) / (longest * 0.62)
}

const Division: React.FC<{ d: SceneDiv; box: Box; ctx: Ctx; heads: boolean; folded: boolean; inside?: SceneDiv[] }> = ({ d, box, ctx, heads, folded, inside }) => {
  const srcId = heldCard(d)
  const src = srcId ? ctx.groups.find(g => g.id === srcId) : undefined
  // Its own copy, or its card as it is now (following live).
  const shown = shownContent(d, src)
  const pic = shown.image ?? null
  const crop = d.crop ?? { x: 50, y: 50, z: 1 }
  const header = shown.name
  const text = shown.notes.trim()
  // Typing in a live division: it stops following, keeping what showed.
  const freeze = () => { if (d.live && src) ctx.patch(d.id, { ...copyFrom(src, false), live: false }, true) }
  // How it shows, by the room it has.
  const state: 'row' | 'stand' | 'icon' | 'full' =
    box.h < ROW_H ? 'row'
    : box.w < STAND_W ? 'stand'
    : (box.w < ICON_W || box.h < ICON_H) && (!!pic || !!d.face) ? 'icon'
    : 'full'
  const nameFont = state === 'row' ? clamp(box.h * 0.46, 3, 6.5)
    : state === 'stand' ? clamp(box.w * 0.5, 3, 6.5)
    : state === 'icon' ? clamp(Math.min(box.w * 0.13, box.h * 0.16), 3, 6.5)
    : clamp(Math.min(box.h * 0.26, box.w * 0.11, wordFit(header, box.w - 4)), 2.6, 11)
  // Words never break in two: the text gets smaller first.
  const textFont = clamp(Math.min(nameFont * 0.68, wordFit(text, box.w - 4)), 2.2, 9)
  const bump = ctx.bumps && !!d.bump
  const lift = bump ? Math.min(box.h * 0.22, 7) : 0
  const faded = ctx.lit && !ctx.lit.has(d.id)
  const picked = ctx.picked === d.id
  const hovered = ctx.hovered === d.id && !ctx.linking && !ctx.dragging
  const moving = ctx.moving === d.id && !!pic
  const opened = !!d.opens && ctx.groups.some(g => g.id === d.opens)
  const changed = cardChanged(d, src)
  const click = useClick(ctx, () => {
    if (ctx.focus) ctx.toggleFocus(d.id)
    ctx.pick(d.id)
  })
  // Click a name or notes and type: no panel, no second click.
  const nameClick = useClick(ctx, e => {
    if (ctx.focus) return
    e.stopPropagation()
    freeze()
    ctx.pick(d.id)
    ctx.setRenaming(d.id)
  })
  const notesClick = useClick(ctx, e => {
    if (ctx.focus) return
    e.stopPropagation()
    freeze()
    ctx.pick(d.id)
    ctx.setNoting(d.id)
  })
  const shadow = '0 0.5px 1.5px rgba(0,0,0,0.75)'
  const nameEl = ctx.renaming === d.id
    ? <NameInput d={d} ctx={ctx} font={nameFont} />
    : header
      ? <span data-scene-name={d.id} {...nameClick} style={{ cursor: 'text', pointerEvents: 'auto' }}>{header}</span>
      : null
  const round = (size: number) => pic && (
    <div style={{
      flex: '0 0 auto', width: size, height: size, borderRadius: '50%', overflow: 'hidden',
      border: `${Math.max(0.4, size * 0.04)}px solid rgba(255,255,255,0.85)`, boxSizing: 'border-box', boxShadow: '0 0.5px 1.5px rgba(0,0,0,0.4)',
    }}>
      <img src={pic} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: `${crop.x}% ${crop.y}%`, pointerEvents: 'none' }} />
    </div>
  )

  // The parts tucked inside this heading: a small round picture each, or a
  // dot in its colour.
  const dots = (size: number, wrap: boolean) => inside && inside.length > 0 && (
    <div data-scene-inside style={{ display: 'flex', flexWrap: wrap ? 'wrap' : 'nowrap', justifyContent: 'center', gap: size * 0.3, maxWidth: '100%', overflow: 'hidden', flex: '0 1 auto', minWidth: 0 }}>
      {inside.slice(0, 24).map(l => ({ l, img: shownContent(l, ctx.groups.find(g => g.id === heldCard(l))).image })).map(({ l, img }) => (
        <div key={l.id} title={l.name} style={{
          flex: '0 0 auto', width: size, height: size, borderRadius: '50%', background: l.color ?? '#5b8dd9', overflow: 'hidden',
          border: `${Math.max(0.3, size * 0.1)}px solid rgba(255,255,255,0.8)`, boxSizing: 'border-box',
        }}>
          {img && <img src={img} alt="" draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: `${l.crop?.x ?? 50}% ${l.crop?.y ?? 50}%`, pointerEvents: 'none' }} />}
        </div>
      ))}
    </div>
  )

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
  const u = ctx.u
  const roomy = box.w > u * 3.2 && box.h > u * 2.4

  return (
    <div
      data-scene-div={d.id}
      data-scene-state={state}
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
        position: 'absolute', left: box.x, top: box.y - lift, width: box.w, height: box.h + lift, zIndex: hovered ? 6 : bump ? 3 : picked ? 2 : 1,
        filter: faded ? 'grayscale(0.85) brightness(0.5)' : undefined, opacity: faded ? 0.75 : 1,
        transition: ctx.dragging ? 'filter 0.18s, opacity 0.18s' : 'left 0.24s ease, top 0.24s ease, width 0.24s ease, height 0.24s ease, filter 0.18s, opacity 0.18s',
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
        {pic && state === 'full' && (
          <img src={pic} alt="" draggable={false} data-scene-pic style={{
            position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none',
            objectPosition: `${crop.x}% ${crop.y}%`, transformOrigin: `${crop.x}% ${crop.y}%`, opacity: d.hero?.opacity ?? 1,
            transform: `scale(${crop.z * (d.hero?.flipH ? -1 : 1)}, ${crop.z * (d.hero?.flipV ? -1 : 1)})`,
          }} />
        )}
        {state === 'row' ? (
          // One row: round picture, the header, the text. A bare heading:
          // its name in the middle.
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: pic || text ? 'flex-start' : 'center', gap: 1.5,
            padding: `0 ${heads ? u * 1.1 : 2}px`, boxSizing: 'border-box', overflow: 'hidden', color: '#fff', textShadow: shadow, pointerEvents: 'none',
          }}>
            {round(box.h * 0.78)}
            {nameEl && <span style={{ flex: '0 1 auto', fontSize: nameFont, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{nameEl}</span>}
            {text && <span style={{ flex: '1 1 0', fontSize: textFont * 0.85, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, opacity: 0.9 }}>{text}</span>}
            {dots(box.h * 0.42, false)}
          </div>
        ) : state === 'stand' ? (
          // A standing strip: round picture on top, its header on end.
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5,
            padding: '2px 0', boxSizing: 'border-box', overflow: 'hidden', color: '#fff', textShadow: shadow, pointerEvents: 'none',
          }}>
            {round(box.w * 0.78)}
            {header && <span style={{
              writingMode: 'vertical-rl', transform: 'rotate(180deg)', fontSize: nameFont, fontWeight: 700, whiteSpace: 'nowrap',
              overflow: 'hidden', textOverflow: 'ellipsis', minHeight: 0, flex: '1 1 0', textAlign: 'end',
            }}>{header}</span>}
          </div>
        ) : state === 'icon' ? (
          // An icon: round picture, its header under it.
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1,
            padding: 1.5, boxSizing: 'border-box', overflow: 'hidden', color: '#fff', textShadow: shadow, pointerEvents: 'none', textAlign: 'center',
          }}>
            {round(Math.min(box.w * 0.62, box.h * 0.58))}
            {nameEl && <div style={{ fontSize: nameFont, fontWeight: 700, lineHeight: 1.1, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{nameEl}</div>}
          </div>
        ) : d.face ? (
          // Its own card face: drawn and edited as a card's is, with the
          // same toolbar (fonts, spacing, split...). Never the card's.
          <GroupCardText groupId={ctx.sceneId} heroImage={pic} onCropImage={() => { ctx.pick(d.id); ctx.setMoving(d.id) }} bind={{
            header, body: shown.notes, headerStyle: d.hstyle, bodyStyle: d.bstyle, split: d.split, hero: d.hero,
            scale: clamp(Math.min(box.w / NAT_W, box.h / (NAT_H * 0.5)), 0.12, 2.5),
            setHeader: v => ctx.patch(d.id, d.live && src ? { ...copyFrom(src, false), live: false, name: v } : { name: v }),
            setBody: v => ctx.patch(d.id, d.live && src ? { ...copyFrom(src, false), live: false, notes: v } : { notes: v }),
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
            {dots(clamp(Math.min(box.w, box.h) * 0.1, 2.5, 6), true)}
            {ctx.noting === d.id ? <NotesInput d={d} ctx={ctx} font={textFont} />
              : text ? <div data-scene-notes {...notesClick} style={{ fontSize: textFont, lineHeight: 1.25, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', textShadow: shadow, maxWidth: '100%', opacity: 0.95, cursor: 'text', pointerEvents: 'auto' }}>{shown.notes}</div>
              : picked && !inside?.length && <div data-scene-notes-add {...notesClick} style={{ fontSize: textFont, opacity: 0.55, fontStyle: 'italic', cursor: 'text', pointerEvents: 'auto', textShadow: shadow }}>notes</div>}
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
          {src && hovered && (
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
      {/* A section's heading: fold the section to this strip, and back.
          Shown while pointed at, and always while folded (lit). */}
      {heads && (hovered || folded) && (
        <Knob ctx={ctx} tool="fold" lit={folded} title={folded ? 'Open this section' : 'Fold this section to one strip'}
          at={box.w < STAND_W ? { left: (box.w - u) / 2, top: Math.min(1, box.h - u) } : { left: Math.min(1, box.w - u) , top: (box.h + lift - u) / 2 }}
          onClick={() => ctx.patch(sectionId(ctx, d.id)!, { fold: !folded })}>
          <Glyph ctx={ctx} d={FOLD} />
        </Knob>
      )}
      {/* Pointed at: divide it (a "+" on its right edge and its bottom
          edge), its colour, and more. */}
      {hovered && !moving && (<>
        {roomy && (<>
          <Knob ctx={ctx} tool="split-row" title="Divide it side by side" at={{ left: box.w - u * 0.5, top: (box.h + lift - u) / 2 }}
            onClick={() => { const r = ctx.root(); if (r) ctx.write(splitDiv(r, d.id, 'row')) }}>
            <Glyph ctx={ctx} d={PLUS} />
          </Knob>
          <Knob ctx={ctx} tool="split-col" title="Divide it top and bottom" at={{ left: (box.w - u) / 2, top: box.h + lift - u * 0.5 }}
            onClick={() => { const r = ctx.root(); if (r) ctx.write(splitDiv(r, d.id, 'col')) }}>
            <Glyph ctx={ctx} d={PLUS} />
          </Knob>
        </>)}
        {box.w > u * 2.4 && (
          <Knob ctx={ctx} tool="color" title="Colour" bg={d.color ?? '#5b8dd9'} at={{ left: box.w - u * 2.25, top: u * 0.15 }}
            onClick={e => ctx.openPicker(d.id, e.clientX, e.clientY)} />
        )}
        <Knob ctx={ctx} tool="more" title="More" at={{ left: Math.max(0, box.w - u * 1.1), top: u * 0.15 }}
          onClick={e => ctx.openMenu(d.id, e.clientX, e.clientY)}>
          <Glyph ctx={ctx} d={MORE} />
        </Knob>
      </>)}
    </div>
  )
}

const sectionId = (ctx: Ctx, leafId: string) => { const r = ctx.root(); return r ? sectionOf(r, leafId)?.id : undefined }

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
const Seam: React.FC<{ split: SceneDiv; i: number; box: Box; unit: number; ctx: Ctx }> = ({ split, i, box, unit, ctx }) => {
  const row = split.dir === 'row'
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    // A pointer move in flat screen px, divided by the face's scale, is a
    // move in layout units; a share is worth `unit` of them.
    const sizes = split.sizes ?? split.kids!.map(() => 1 / split.kids!.length)
    const a0 = sizes[i], b0 = sizes[i + 1]
    const start = row ? e.clientX : e.clientY
    useUndoCoordinator.getState().checkpoint()
    ctx.setDragging(true)
    const MIN = 0.02
    const onMove = (ev: PointerEvent) => {
      const d = ((row ? ev.clientX : ev.clientY) - start) / ctx.s / Math.max(1, unit)
      const a = Math.max(MIN, Math.min(a0 + b0 - MIN, a0 + d))
      const r = ctx.root()
      if (r) useBoardsStore.getState().setGroupScene(ctx.sceneId, resizeSplit(r, split.id, i, a, a0 + b0 - a))
    }
    const onUp = () => { ctx.setDragging(false); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
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

/** A switch in the view widget: lit while on; its label never changes. */
const Toggle: React.FC<{ on: boolean; title: string; tool: string; onClick: () => void; children: React.ReactNode }> = ({ on, title, tool, onClick, children }) => (
  <button
    type="button"
    data-scene-tool={tool}
    title={title}
    onPointerDown={stopPress}
    onDoubleClick={e => e.stopPropagation()}
    onClick={e => { e.stopPropagation(); onClick() }}
    style={{
      height: 16, minWidth: 16, padding: '0 5px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
      fontSize: 9.5, lineHeight: 1, fontWeight: 600, borderRadius: 8, cursor: 'pointer', whiteSpace: 'nowrap',
      color: on ? '#111' : '#e6e9ef', background: on ? '#ffd666' : 'rgba(255,255,255,0.08)',
      border: on ? '1px solid #ffd666' : '1px solid rgba(255,255,255,0.22)', fontFamily: 'inherit',
    }}
  >{children}</button>
)

/** A division's "more": a small list by it, each line a switch (lit while
 *  on) or an action. Closes on a pick, a press elsewhere or Esc. */
const MoreMenu: React.FC<{
  x: number; y: number; onClose: () => void
  items: { label: string; tool: string; lit?: boolean; danger?: boolean; act: () => void }[]
}> = ({ x, y, onClose, items }) => {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey) }
  }, [onClose])
  const left = Math.min(x + 6, window.innerWidth - 190)
  const top = Math.min(y + 6, window.innerHeight - items.length * 24 - 12)
  return (
    <div ref={ref} data-scene-more onPointerDown={e => e.stopPropagation()} style={{
      position: 'fixed', left, top, zIndex: 10000, minWidth: 170, padding: 4, borderRadius: 8,
      background: 'rgba(18,20,28,0.96)', border: '1px solid rgba(255,255,255,0.14)', boxShadow: '0 6px 20px rgba(0,0,0,0.55)',
      display: 'flex', flexDirection: 'column', gap: 1, fontFamily: 'inherit',
    }}>
      {items.map(it => (
        <button key={it.tool} type="button" data-scene-tool={it.tool}
          onClick={() => { it.act(); onClose() }}
          style={{
            display: 'flex', alignItems: 'center', gap: 7, height: 22, padding: '0 8px', border: 'none', borderRadius: 5, cursor: 'pointer',
            background: 'transparent', color: it.danger ? '#ff8a80' : '#e6e9ef', fontSize: 11.5, textAlign: 'left', fontFamily: 'inherit',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
        >
          <span style={{
            width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto',
            background: it.lit ? '#ffd666' : 'transparent', border: it.lit === undefined ? 'none' : '1px solid rgba(255,255,255,0.4)',
          }} />
          {it.label}
        </button>
      ))}
    </div>
  )
}

export const SceneFace: React.FC<{
  group: ProjectGroup; width: number; height: number
  /** Kept for the card's call; the face runs to the top (its buttons show
   *  over the first division on hover). */
  reserve?: number
}> = ({ group, width, height }) => {
  const groups = useBoardsStore(s => s.groups)
  const linking = useLinkDragStore(s => s.active && s.source?.kind === 'group' && s.source.id !== group.id)
  const zoom = useCanvasStore(st => st.zoom) || 1
  const [hover, setHover] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [noting, setNoting] = useState<string | null>(null)
  const [hoveredDiv, setHoveredDiv] = useState<string | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [picker, setPicker] = useState<{ id: string; x: number; y: number } | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
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
      if ((t as HTMLElement | null)?.closest?.('[data-color-picker], [data-scene-more], [data-text-format-toolbar]')) return
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
  // Organic sizing: text and controls grow slower than the card, so a
  // smaller card has less room in layout units and its divisions step down
  // through face -> icon -> row -> strip instead of just shrinking.
  // By the card's own size on the canvas, never the view's zoom: zooming
  // never changes the layout.
  const fit = Math.max(0.01, Math.min(width / NAT_W, height / NAT_H) / zoom)
  const s = Math.sqrt(fit * SIZE_REF) * zoom
  const W = width / s, H = height / s
  const iw = W - PAD * 2, ih = H - PAD * 2
  const tucked = new Set<string>()
  const boxes = divBoxes(scene, iw, ih, GAP, tucked)
  const root = () => useBoardsStore.getState().groups.find(g => g.id === group.id)?.scene
  const setView = (patch: Partial<SceneView>) => {
    useUndoCoordinator.getState().checkpoint()
    const g = useBoardsStore.getState().groups.find(gr => gr.id === group.id)
    useBoardsStore.getState().setGroupSceneView(group.id, { ...(g?.sceneView ?? {}), ...patch })
  }
  const ctx: Ctx = {
    sceneId: group.id, s, u: TOOL_PX / s, groups, linking, renaming, setRenaming, noting, setNoting,
    picked, pick: id => { setPicked(id); if (id !== moving) setMoving(null) }, lit, hovered: hoveredDiv, setHovered: setHoveredDiv,
    moving, setMoving, dragging, setDragging,
    openMenu: (id, x, y) => setMenu({ id, x, y }),
    openPicker: (id, x, y) => setPicker({ id, x, y }),
    patch: (id, p, step = true) => {
      const r = root()
      if (!r) return
      if (step) useUndoCoordinator.getState().checkpoint()
      useBoardsStore.getState().setGroupScene(group.id, patchDiv(r, id, p))
    },
    bumps: view.bumps !== false, focus: !!view.focus,
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

  // Leaves and seams, laid out absolutely from the tree. A folded section
  // shows its heading only; no seam touches a folded part.
  const parts: React.ReactNode[] = []
  const walk = (d: SceneDiv) => {
    const b = boxes.get(d.id)
    if (!b) return
    if (isLeaf(d)) {
      const sec = sectionOf(scene, d.id)
      // A tucked section's heading carries a dot for each part inside.
      const inside = sec && (tucked.has(sec.id) || sec.fold) ? leaves(sec).filter(l => l.id !== d.id) : undefined
      parts.push(<Division key={d.id} d={d} box={b} ctx={ctx} heads={!!sec} folded={!!sec?.fold} inside={inside} />)
      return
    }
    if ((d.fold && canFold(d)) || tucked.has(d.id)) { walk(d.kids![0]); return }
    const n = d.kids!.length
    const unit = shareUnits(d, b, GAP)
    d.kids!.forEach((k, i) => {
      walk(k)
      const next = d.kids![i + 1]
      if (next && !(k.fold && canFold(k)) && !(next.fold && canFold(next)) && boxes.get(k.id)) {
        parts.push(<Seam key={`${d.id}:${i}`} split={d} i={i} box={boxes.get(k.id)!} unit={unit} ctx={ctx} />)
      }
    })
    void n
  }
  walk(scene)

  const canRemove = leaves(scene).length > 1
  const edit = (fn: (r: SceneDiv) => SceneDiv) => { const r = root(); if (r) ctx.write(fn(r)) }
  const pickedColor = picker ? leaves(scene).find(l => l.id === picker.id)?.color ?? '#5b8dd9' : '#5b8dd9'
  const anyMode = !!view.focus || !!view.trace
  const showModes = (hover || anyMode) && !linking

  // The "more" list for a division.
  const menuDiv = menu ? findDiv(scene, menu.id) : null
  const menuItems = menuDiv && isLeaf(menuDiv) ? (() => {
    const d = menuDiv
    const sec = sectionOf(scene, d.id)
    const items: { label: string; tool: string; lit?: boolean; danger?: boolean; act: () => void }[] = [
      { label: 'Bump out (stand taller)', tool: 'bump', lit: !!d.bump, act: () => edit(r => patchDiv(r, d.id, { bump: !d.bump })) },
      { label: 'Open as its own scene card', tool: 'open', lit: !!d.opens && groups.some(g => g.id === d.opens), act: () => openDivision(group.id, d.id) },
    ]
    if (sec) items.push({ label: 'Fold this section', tool: 'fold-section', lit: !!sec.fold, act: () => edit(r => patchDiv(r, sec.id, { fold: !sec.fold })) })
    if (d.image) {
      items.push({ label: 'Move picture', tool: 'move-picture', lit: moving === d.id, act: () => { setPicked(d.id); setMoving(moving === d.id ? null : d.id) } })
      items.push({ label: 'Take the picture off', tool: 'remove-picture', act: () => { setMoving(null); edit(r => patchDiv(r, d.id, { image: undefined, crop: undefined })) } })
    }
    const card = heldCard(d) ? groups.find(g => g.id === heldCard(d)) : undefined
    if (card) items.push({
      label: 'Follow its card live', tool: 'live', lit: !!d.live,
      // Off again: it keeps what it shows now, as its own copy.
      act: () => edit(r => patchDiv(r, d.id, d.live ? { ...copyFrom(card, false), live: false } : { live: true })),
    })
    // Its card a 3D area card (utils/area3dCard): its scene laid out, or
    // folded back in, from here.
    if (card && (card.cardType === 'area3d' || card.area3d)) items.push({
      label: 'Show its 3D area', tool: 'area3d', lit: !!area3dOutOf(card.id), act: () => toggleArea3d(card.id),
    })
    if (heldCard(d)) items.push({ label: 'Unlink from its card', tool: 'unlink', act: () => edit(r => takeCard(d.live && card ? patchDiv(r, d.id, { ...copyFrom(card, false), live: false }) : r, d.id)) })
    if (canRemove) items.push({ label: 'Remove this division', tool: 'remove', danger: true, act: () => { edit(r => removeDiv(r, d.id)); setPicked(null) } })
    return items
  })() : null

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
      {showModes && (
        // The scene's view modes: a small widget in its bottom-right corner,
        // shown while pointed at, and while a mode is on.
        <div
          data-scene-modes
          onPointerDown={stopPress}
          onDoubleClick={e => e.stopPropagation()}
          onWheel={e => e.stopPropagation()}
          style={{
            position: 'absolute', right: 5, bottom: 5, zIndex: 20, display: 'flex', alignItems: 'center', gap: 3, padding: 3,
            borderRadius: 11, background: 'rgba(16,18,26,0.82)', border: '1px solid rgba(255,255,255,0.14)',
            boxShadow: '0 2px 8px rgba(0,0,0,0.45)', cursor: 'default', maxWidth: 'calc(100% - 10px)', flexWrap: 'wrap', justifyContent: 'flex-end',
          }}
        >
          <Toggle tool="view-focus" on={!!view.focus} title="Focus: click divisions to light them (a section's heading lights the section); the rest fade" onClick={() => setView({ focus: !view.focus })}>Focus</Toggle>
          <Toggle tool="view-bumps" on={view.bumps !== false} title="Bump-outs: divisions marked to bump out stand taller" onClick={() => setView({ bumps: view.bumps === false })}>Bump-outs</Toggle>
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
                height: 16, width: 96, boxSizing: 'border-box', padding: '0 6px', fontSize: 9.5, color: '#fff', fontFamily: 'inherit',
                background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.3)', borderRadius: 8, outline: 'none', userSelect: 'text',
              }}
            />
          )}
          {view.focus && (view.picked?.length ?? 0) > 0 && (
            <Toggle tool="view-focus-clear" on={false} title="Light every division again" onClick={() => setView({ picked: [] })}>Clear</Toggle>
          )}
        </div>
      )}
      {menu && menuItems && ReactDOM.createPortal(
        <MoreMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />,
        document.body,
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
