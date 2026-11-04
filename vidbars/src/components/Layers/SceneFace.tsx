// A SCENE card's face (Brian's storyMap, 2026-11-04): its divisions, named
// and coloured, filling the face. Drag the line between two to resize
// them; hover one for its tools (split side by side, split above/below,
// colour, remove); click its name to rename it. A card's link "+" let go
// on a division puts that card in it (with the others selected with it),
// shown there as a small card. Data: ProjectGroup.scene (utils/sceneCard).

import React, { useEffect, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useLinkDragStore } from '../../store/linkDragStore'
import { cardFaceMedia } from '../../utils/cardGrid'
import { isLeaf, patchDiv, removeDiv, resizeSplit, splitDiv, takeCard, leaves, type SceneDiv } from '../../utils/sceneCard'
import { HeroImageLayer } from './HeroImageLayer'
import { ColorPickerPopup } from '../Bar/ColorPickerPopup'

/** Laid out at a new card's size and scaled with the card, like its back. */
const NAT_W = 125
const NAT_H = 184
const GAP = 3

const stopPress = (e: React.PointerEvent) => { if (e.button === 0) e.stopPropagation() }

type Ctx = {
  sceneId: string
  s: number
  where: () => { x: number; y: number }
  write: (next: SceneDiv) => void
  root: () => SceneDiv | undefined
  hovered: string | null
  setHovered: (id: string | null) => void
  linking: boolean
  renaming: string | null
  setRenaming: (id: string | null) => void
  pickColor: (id: string, x: number, y: number) => void
  groups: ProjectGroup[]
  canRemove: boolean
}

/** A small card in a division: its face picture, else its colour. */
const SceneThumb: React.FC<{ card: ProjectGroup; onRemove: () => void }> = ({ card, onRemove }) => {
  const boards = useBoardsStore(s => s.boards)
  const face = cardFaceMedia(card, boards)
  const pic = face?.type === 'image' ? face.url : face?.posterUrl ?? null
  const [hover, setHover] = useState(false)
  return (
    <div
      data-scene-card={card.id}
      title={card.name}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      style={{
        position: 'relative', height: 22, aspectRatio: '0.68', flexShrink: 0, borderRadius: 2, overflow: 'hidden',
        background: card.color, border: '1px solid rgba(255,255,255,0.55)', boxShadow: '0 1px 2px rgba(0,0,0,0.4)',
      }}
    >
      {pic && <HeroImageLayer heroImage={pic} opacity={1} borderRadius={1} />}
      {!pic && <div style={{ position: 'absolute', inset: 1, fontSize: 5, fontWeight: 700, lineHeight: 1.1, overflow: 'hidden', color: '#fff' }}>{card.name}</div>}
      {hover && (
        <button
          type="button"
          data-scene-card-remove
          title="Take out of this division"
          onPointerDown={stopPress}
          onClick={e => { e.stopPropagation(); onRemove() }}
          style={{ position: 'absolute', right: 0, top: 0, width: 8, height: 8, padding: 0, fontSize: 7, lineHeight: '7px', border: 'none', borderRadius: 2, cursor: 'pointer', background: 'rgba(0,0,0,0.7)', color: '#fff' }}
        >×</button>
      )}
    </div>
  )
}

const ToolBtn: React.FC<{ title: string; onClick: (e: React.MouseEvent) => void; children: React.ReactNode; tool: string }> = ({ title, onClick, children, tool }) => (
  <button
    type="button"
    data-scene-tool={tool}
    title={title}
    onPointerDown={stopPress}
    onDoubleClick={e => e.stopPropagation()}
    onClick={e => { e.stopPropagation(); onClick(e) }}
    style={{
      width: 10, height: 10, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 7, lineHeight: 1, fontWeight: 800, borderRadius: 2, cursor: 'pointer', color: '#fff',
      background: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.35)',
    }}
  >{children}</button>
)

/** A division's name: click (not drag) to rename. */
const DivName: React.FC<{ d: SceneDiv; ctx: Ctx }> = ({ d, ctx }) => {
  const editing = ctx.renaming === d.id
  const [draft, setDraft] = useState(d.name ?? '')
  const ref = useRef<HTMLInputElement>(null)
  const down = useRef<{ x: number; y: number } | null>(null)
  const done = useRef(false)
  useEffect(() => {
    if (!editing) return
    done.current = false
    setDraft(d.name ?? '')
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.select() })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing])
  const font: React.CSSProperties = { fontSize: 7.5, fontWeight: 700, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.45)' }
  if (editing) {
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
        style={{ ...font, width: '80%', minWidth: 0, boxSizing: 'border-box', padding: '0 2px', margin: 0, fontFamily: 'inherit', background: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.5)', borderRadius: 2, outline: 'none', userSelect: 'text' }}
      />
    )
  }
  return (
    <div
      data-scene-name={d.id}
      onPointerDown={() => { down.current = ctx.where() }}
      onClick={e => {
        const a = down.current, b = ctx.where()
        down.current = null
        if (e.button !== 0 || !a || Math.hypot(a.x - b.x, a.y - b.y) > 0.5) return
        e.stopPropagation()
        ctx.setRenaming(d.id)
      }}
      onDoubleClick={e => e.stopPropagation()}
      style={{ ...font, cursor: 'text', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%', alignSelf: 'flex-start', padding: '0 1px' }}
    >{d.name || <span style={{ opacity: 0.5 }}>name</span>}</div>
  )
}

const Division: React.FC<{ d: SceneDiv; ctx: Ctx }> = ({ d, ctx }) => {
  const cards = (d.cards ?? []).flatMap(id => ctx.groups.find(g => g.id === id) ?? [])
  const hover = ctx.hovered === d.id
  return (
    <div
      data-scene-div={d.id}
      data-link-drop={`division:${ctx.sceneId}:${d.id}`}
      onPointerEnter={() => ctx.setHovered(d.id)}
      onPointerLeave={() => ctx.setHovered(null)}
      style={{
        position: 'relative', width: '100%', height: '100%', boxSizing: 'border-box', borderRadius: 3, overflow: 'hidden',
        background: d.color ?? '#5b8dd9', padding: '2px 3px', display: 'flex', flexDirection: 'column', gap: 2,
        outline: ctx.linking ? '1px dashed rgba(255,255,255,0.85)' : undefined, outlineOffset: -2,
      }}
    >
      <DivName d={d} ctx={ctx} />
      {cards.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2, overflow: 'hidden', minHeight: 0 }}>
          {cards.map(c => (
            <SceneThumb key={c.id} card={c} onRemove={() => { const r = ctx.root(); if (r) ctx.write(takeCard(r, d.id, c.id)) }} />
          ))}
        </div>
      )}
      {hover && !ctx.linking && ctx.renaming !== d.id && (
        <div style={{ position: 'absolute', right: 2, top: 2, display: 'flex', gap: 1.5 }}>
          <ToolBtn tool="split-row" title="Divide it side by side" onClick={() => { const r = ctx.root(); if (r) ctx.write(splitDiv(r, d.id, 'row')) }}>
            <svg width="7" height="7" viewBox="0 0 8 8"><rect x="0.5" y="0.5" width="7" height="7" fill="none" stroke="#fff" strokeWidth="1" /><line x1="4" y1="0.5" x2="4" y2="7.5" stroke="#fff" strokeWidth="1" /></svg>
          </ToolBtn>
          <ToolBtn tool="split-col" title="Divide it top and bottom" onClick={() => { const r = ctx.root(); if (r) ctx.write(splitDiv(r, d.id, 'col')) }}>
            <svg width="7" height="7" viewBox="0 0 8 8"><rect x="0.5" y="0.5" width="7" height="7" fill="none" stroke="#fff" strokeWidth="1" /><line x1="0.5" y1="4" x2="7.5" y2="4" stroke="#fff" strokeWidth="1" /></svg>
          </ToolBtn>
          <ToolBtn tool="color" title="Colour" onClick={e => ctx.pickColor(d.id, e.clientX, e.clientY)}>
            <span style={{ width: 5, height: 5, borderRadius: 3, background: 'conic-gradient(#f2994a, #5b8dd9, #1f9ea6, #8b6fd6, #f2994a)' }} />
          </ToolBtn>
          {ctx.canRemove && (
            <ToolBtn tool="remove" title="Remove this division (its neighbour takes the space)" onClick={() => { const r = ctx.root(); if (r) ctx.write(removeDiv(r, d.id)) }}>×</ToolBtn>
          )}
        </div>
      )}
    </div>
  )
}

/** The line between two parts of a split: drag it to share the space
 *  between them differently. */
const Seam: React.FC<{ split: SceneDiv; i: number; ctx: Ctx; boxRef: React.RefObject<HTMLDivElement | null> }> = ({ split, i, ctx, boxRef }) => {
  const row = split.dir === 'row'
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const box = boxRef.current
    if (!box) return
    // The split's own size in its layout units (unaffected by the card's
    // scale or the 3D view): a pointer move in flat screen px, divided by
    // the face's scale, is a move in those units.
    const total = (row ? box.offsetWidth : box.offsetHeight) - GAP * (split.kids!.length - 1)
    const sizes = split.sizes ?? split.kids!.map(() => 1 / split.kids!.length)
    const a0 = sizes[i], b0 = sizes[i + 1]
    const start = row ? e.clientX : e.clientY
    useUndoCoordinator.getState().checkpoint()
    const MIN = 0.04
    const onMove = (ev: PointerEvent) => {
      const d = ((row ? ev.clientX : ev.clientY) - start) / ctx.s / Math.max(1, total)
      const a = Math.max(MIN, Math.min(a0 + b0 - MIN, a0 + d))
      const r = ctx.root()
      if (r) useBoardsStore.getState().setGroupScene(ctx.sceneId, resizeSplit(r, split.id, i, a, a0 + b0 - a))
    }
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  return (
    <div
      data-scene-seam={`${split.id}:${i}`}
      onPointerDown={onDown}
      onDoubleClick={e => e.stopPropagation()}
      style={{ flex: `0 0 ${GAP}px`, cursor: row ? 'col-resize' : 'row-resize', alignSelf: 'stretch' }}
    />
  )
}

const Split: React.FC<{ d: SceneDiv; ctx: Ctx }> = ({ d, ctx }) => {
  const boxRef = useRef<HTMLDivElement>(null)
  if (isLeaf(d)) return <Division d={d} ctx={ctx} />
  const sizes = d.sizes ?? d.kids!.map(() => 1 / d.kids!.length)
  return (
    <div ref={boxRef} style={{ display: 'flex', flexDirection: d.dir === 'row' ? 'row' : 'column', width: '100%', height: '100%', minWidth: 0, minHeight: 0 }}>
      {d.kids!.map((k, i) => (
        <React.Fragment key={k.id}>
          {i > 0 && <Seam split={d} i={i - 1} ctx={ctx} boxRef={boxRef} />}
          <div style={{ flex: `${sizes[i]} 1 0`, minWidth: 0, minHeight: 0, display: 'flex' }}>
            <Split d={k} ctx={ctx} />
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}

export const SceneFace: React.FC<{
  group: ProjectGroup; width: number; height: number
  /** Screen px kept clear along the top for the card's own buttons (Flip, pen). */
  reserve: number
}> = ({ group, width, height, reserve }) => {
  const groups = useBoardsStore(s => s.groups)
  const linking = useLinkDragStore(s => s.active && s.source?.kind === 'group' && s.source.id !== group.id)
  const [hovered, setHovered] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [picker, setPicker] = useState<{ id: string; x: number; y: number } | null>(null)
  const scene = group.scene
  if (!scene) return null
  const s = Math.max(0.01, Math.min(width / NAT_W, height / NAT_H))
  const root = () => useBoardsStore.getState().groups.find(g => g.id === group.id)?.scene
  const ctx: Ctx = {
    sceneId: group.id, s, groups, linking, hovered, setHovered, renaming, setRenaming,
    where: () => {
      const g = useBoardsStore.getState().groups.find(gr => gr.id === group.id)
      return { x: g?.originX ?? 0, y: g?.originY ?? 0 }
    },
    root,
    write: next => { useUndoCoordinator.getState().checkpoint(); useBoardsStore.getState().setGroupScene(group.id, next) },
    pickColor: (id, x, y) => setPicker({ id, x, y }),
    canRemove: leaves(scene).length > 1,
  }
  const pickedColor = picker ? leaves(scene).find(l => l.id === picker.id)?.color ?? '#5b8dd9' : '#5b8dd9'
  return (
    <div data-scene-face={group.id} style={{ position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: '0 0 12px 12px' }}>
      <div style={{
        position: 'absolute', left: 0, top: 0, width: width / s, height: height / s,
        transform: `scale(${s})`, transformOrigin: '0 0', boxSizing: 'border-box', padding: 4, paddingTop: Math.max(4, reserve / s), display: 'flex',
        fontFamily: 'inherit',
      }}>
        <Split d={scene} ctx={ctx} />
      </div>
      {picker && ReactDOM.createPortal(
        <ColorPickerPopup
          color={pickedColor}
          anchorX={picker.x}
          anchorY={picker.y}
          onChange={c => { const r = root(); if (r) { useUndoCoordinator.getState().checkpoint(); useBoardsStore.getState().setGroupScene(group.id, patchDiv(r, picker.id, { color: c })) } }}
          onClose={() => setPicker(null)}
        />,
        document.body,
      )}
    </div>
  )
}
