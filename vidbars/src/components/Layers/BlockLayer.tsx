// BlockLayer — board-level block view (0.15 < zoom < 0.3)
// Renders one solid colored rectangle per board + a thin NLE header bar.
// Uses layer-specific data (board.layers.block.thumbnail / label).
// Grip handle on block headers allows lifting a board to reassign it to a different group.

import React, { useMemo, useState, useRef, useCallback } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore, getGroupForBoard } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { DEFAULT_BLOCK_HEADER_STYLE, DEFAULT_BODY_STYLE } from '../../store/freeNodeStore'
import type { TextStyle } from '../../store/freeNodeStore'
import type { TextFieldMode } from '../UI/TextFormatToolbar'
import { TextFormatToolbar, hexToRgba, ensureFontLoaded } from '../UI/TextFormatToolbar'
import { computeGroupLayout, getRowY, dyToRowDelta, getBoardAbsolutePos } from '../../utils/nleRows'
import type { RowLayout } from '../../utils/nleRows'
import { groupBoardSlots, clampBoardX } from '../../utils/nlePush'
import { DEFAULT_H } from '../../utils/barConstants'
import { getFirstImageUrl } from '../../types/bar'
import { ColorPickerPopup } from '../Bar/ColorPickerPopup'
import { FreeCanvas } from '../Canvas/FreeCanvas'
import { NLETimelineHeader } from '../NLE/NLETimelineHeader'

const BOARD_PADDING_X = 20

const BLOCK_HEADER_H = 57

const GripDots: React.FC<{ size?: number; opacity?: number }> = ({ size = 10, opacity = 0.35 }) => (
  <svg width={size} height={size} viewBox="0 0 10 10" style={{ opacity, flexShrink: 0 }}>
    {[1, 5, 9].flatMap(cy => [1, 5, 9].map(cx => (
      <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={0.9} fill="rgba(255,255,255,0.8)" />
    )))}
  </svg>
)

const BlockItem: React.FC<{ boardId: string }> = ({ boardId }) => {
  const board = useBoardsStore(s => s.boards[boardId])
  const zoom = useCanvasStore(s => s.zoom)

  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const [colorPicker, setColorPicker] = useState<{ x: number; y: number } | null>(null)
  const [blockMenu, setBlockMenu] = useState<{ x: number; y: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const nameInputRef = useRef<HTMLInputElement>(null)
  const [gripDragging, setGripDragging] = useState(false)

  const commitRename = useCallback(() => {
    if (renameVal.trim()) {
      useBoardsStore.getState().setBlockLabel(boardId, renameVal.trim())
    }
    setRenaming(false)
  }, [boardId, renameVal])

  React.useEffect(() => { if (renaming) nameInputRef.current?.select() }, [renaming])

  if (!board) return null

  const rootBars = board.rootIds.map(id => board.bars[id]).filter(Boolean)
  if (rootBars.length === 0) return null

  const bScale = board.boardScale ?? 1
  const minX = Math.min(...rootBars.map(b => b.x))
  const maxX = Math.max(...rootBars.map(b => b.x + b.width))
  const width = (maxX - minX) * bScale
  const height = Math.max(...rootBars.map(b => b.height), DEFAULT_H) * bScale
  const rootColor = rootBars[0]?.color ?? '#5b8dd9'

  const thumbnail = board.layers?.block?.thumbnail
    ?? rootBars.reduce<string | null>((found, b) => found || getFirstImageUrl(b.content), null)
    ?? null

  const displayLabel = board.layers?.block?.label || board.projectName

  const myGroup = getGroupForBoard(groups, boardId)
  const isUngroupedBlock = !myGroup
  const groupColor = myGroup?.color ?? '#5b8dd9'

  // ── Block drag: board moves within its group (local nleRow / nleX), or free drag if ungrouped ──
  const onSolidDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).tagName === 'INPUT') return
    if ((e.target as Element).closest('[data-grip]')) return
    e.stopPropagation()
    e.preventDefault()
    useUndoCoordinator.getState().checkpoint()

    let lastX = e.clientX
    let lastY = e.clientY
    let dyAccum = 0
    let xAccum = 0

    const bs0 = useBoardsStore.getState()
    const b0 = bs0.boards[boardId]
    if (!b0) return
    const group = getGroupForBoard(bs0.groups, boardId)
    const ungrouped = !group

    // Grouped: row/x clamped drag setup
    const initialRow = b0.nleRow ?? 0
    const initialX = b0.nleX ?? 0
    const dragLay = ungrouped ? null : computeGroupLayout(group.boardIds, bs0.boards)
    const gox = group?.originX ?? 0
    const dragSlots = ungrouped ? [] : groupBoardSlots(gox, group.boardIds, bs0.boards)
    // Ungrouped: free drag start
    const startCX = b0.canvasX ?? 0
    const startCY = b0.canvasY ?? 0

    const onMove = (ev: PointerEvent) => {
      const z = useCanvasStore.getState().zoom
      const dx = (ev.clientX - lastX) / z
      const dy = (ev.clientY - lastY) / z
      lastX = ev.clientX
      lastY = ev.clientY
      dyAccum += dy
      xAccum += dx
      if (ungrouped) {
        useBoardsStore.getState().setUngroupedBoardPos(boardId, startCX + xAccum, startCY + dyAccum)
      } else {
        const newRow = Math.max(0, initialRow + dyToRowDelta(dyAccum, initialRow, dragLay!))
        const rawAbsX = gox + initialX + xAccum
        const clampedAbsX = clampBoardX(dragSlots, boardId, rawAbsX, newRow)
        useBoardsStore.getState().setBoardNlePos(boardId, newRow, clampedAbsX - gox)
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      // Zone transition: ungrouped block dragged into timeline → create group
      if (ungrouped) {
        const b = useBoardsStore.getState().boards[boardId]
        const zly = useCanvasStore.getState().zoneLineY
        if (b && (b.canvasY ?? 0) >= zly) {
          useBoardsStore.getState().groupBoardAsNew(boardId)
        }
      }
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // ── Grip drag: lift board to reassign to another group ──
  const onGripDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    useUndoCoordinator.getState().checkpoint()
    setGripDragging(true)

    let lastX = e.clientX
    let lastY = e.clientY
    let dyAccum = 0
    let xAccum = 0

    const bs0 = useBoardsStore.getState()
    const b0 = bs0.boards[boardId]
    if (!b0) return
    const group = getGroupForBoard(bs0.groups, boardId)
    const initialRow = b0.nleRow ?? 0
    const initialX = b0.nleX ?? 0
    const sourceGroupId = group?.id
    const gripLay = computeGroupLayout(group?.boardIds ?? [boardId], bs0.boards)

    const onMove = (ev: PointerEvent) => {
      const z = useCanvasStore.getState().zoom
      const dx = (ev.clientX - lastX) / z
      const dy = (ev.clientY - lastY) / z
      lastX = ev.clientX
      lastY = ev.clientY
      dyAccum += dy
      xAccum += dx
      const newRow = Math.max(0, initialRow + dyToRowDelta(dyAccum, initialRow, gripLay))
      useBoardsStore.getState().setBoardNlePos(boardId, newRow, initialX + xAccum)
    }

    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setGripDragging(false)

      const allEls = document.elementsFromPoint(ev.clientX, ev.clientY)
      for (const el of allEls) {
        const blockEl = el.closest('[data-layer-block]') as HTMLElement | null
        if (blockEl && blockEl.dataset.layerBlock !== boardId) {
          const targetBoardId = blockEl.dataset.layerBlock!
          const targetGroup = getGroupForBoard(useBoardsStore.getState().groups, targetBoardId)
          if (targetGroup && targetGroup.id !== sourceGroupId) {
            useBoardsStore.getState().reassignBoard(boardId, targetGroup.id)
            return
          }
        }
      }
      const currentGroup = getGroupForBoard(useBoardsStore.getState().groups, boardId)
      if (currentGroup && currentGroup.boardIds.length > 1 && (Math.abs(xAccum) > 50 || Math.abs(dyAccum) > 50)) {
        // Check if dragged into free zone → ungroup
        const bs = useBoardsStore.getState()
        const absPos = getBoardAbsolutePos(boardId, bs.groups, bs.boards)
        const zly = useCanvasStore.getState().zoneLineY
        if (absPos.y < zly) {
          useBoardsStore.getState().ungroupBoard(boardId)
        } else {
          useBoardsStore.getState().moveToNewGroup(boardId)
        }
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // ── Two-level positioning: group origin + local row ──
  const siblingRowKey = useBoardsStore(s => {
    const bids = myGroup?.boardIds ?? [boardId]
    return bids.map(bid => s.boards[bid]?.nleRow ?? 0).join(',')
  })
  const groupLayout = useMemo(() => {
    return computeGroupLayout(myGroup?.boardIds ?? [boardId], useBoardsStore.getState().boards)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [myGroup?.boardIds, siblingRowKey, board?.bars, board?.boardScale])

  const boardX = isUngroupedBlock ? (board.canvasX ?? 0) : (myGroup!.originX + (board.nleX ?? 0))
  const boardY = isUngroupedBlock ? (board.canvasY ?? 0) : (myGroup!.originY + getRowY(board.nleRow ?? 0, groupLayout))

  const left = BOARD_PADDING_X + minX * bScale
  const totalW = Math.max(maxX * bScale, 200)

  const otherGroups = groups.filter(g => g.id !== myGroup?.id)

  return (
    <div
      style={{ position: 'absolute', left: boardX, top: boardY, width: totalW, height: height + BLOCK_HEADER_H }}
      onPointerDownCapture={e => {
        if (e.button !== 0) return
        useBoardsStore.getState().setSelection(boardId, board.rootIds)
      }}
    >
      {/* ── Header bar ── */}
      <div
        style={{
          position: 'absolute', top: 0,
          left, width,
          height: BLOCK_HEADER_H,
          boxSizing: 'border-box',
          display: 'flex', alignItems: 'center', gap: 8, padding: `0 ${12 / zoom}px`,
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 8, backdropFilter: 'blur(12px)',
          cursor: 'grab', zIndex: 30,
          borderLeft: `3px solid ${groupColor}`,
        }}
        onPointerDown={onSolidDown}
      >
        {!isUngroupedBlock && (
          <div
            data-grip="true"
            style={{
              cursor: gripDragging ? 'grabbing' : 'grab',
              padding: '4px 2px',
              borderRadius: 3,
              display: 'flex', alignItems: 'center',
              flexShrink: 0,
            }}
            onPointerDown={onGripDown}
            title="Drag to reassign to another group"
          >
            <GripDots size={12} opacity={gripDragging ? 0.7 : 0.35} />
          </div>
        )}

        {renaming ? (
          <input
            ref={nameInputRef}
            autoFocus
            value={renameVal}
            onChange={e => setRenameVal(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(false) }}
            onPointerDown={e => e.stopPropagation()}
            style={{
              background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.2)',
              borderRadius: 4, color: '#fff', fontSize: 11, fontWeight: 700,
              padding: '1px 6px', outline: 'none', fontFamily: 'inherit', width: 140,
            }}
          />
        ) : (
          <span
            style={{ color: 'rgba(255,255,255,0.75)', fontSize: 11 / zoom, fontWeight: 700, letterSpacing: '0.3px', cursor: 'text', whiteSpace: 'nowrap' }}
            onDoubleClick={e => { e.stopPropagation(); setRenameVal(displayLabel); setRenaming(true) }}
          >{displayLabel}</span>
        )}
      </div>

      {/* ── Block rectangle ── */}
      <div
        data-layer-block={boardId}
        data-block="true"
        data-id={board.rootIds[0]}
        data-board-id={boardId}
        style={{
          position: 'absolute', left, top: BLOCK_HEADER_H, width, height,
          borderRadius: 12,
          background: thumbnail
            ? `linear-gradient(160deg, ${rootColor}cc 0%, ${rootColor}aa 100%)`
            : rootColor,
          border: '1.5px solid rgba(255,255,255,0.25)',
          boxShadow: gripDragging
            ? '0 8px 40px rgba(0,0,0,0.7)'
            : '0 4px 24px rgba(0,0,0,0.4)',
          cursor: 'grab',
          overflow: 'hidden',
          zIndex: gripDragging ? 100 : undefined,
          transition: 'box-shadow 0.15s',
        }}
        onPointerDown={onSolidDown}
        onContextMenu={e => { e.preventDefault(); e.stopPropagation(); setBlockMenu({ x: e.clientX, y: e.clientY }) }}
        onDoubleClick={e => {
          e.stopPropagation()
          const el = e.currentTarget.querySelector('[data-block-text]') as HTMLElement | null
          el?.dispatchEvent(new CustomEvent('start-edit', { bubbles: false }))
        }}
      >
        {thumbnail && (
          <div style={{
            position: 'absolute', inset: 0,
            backgroundImage: `url(${thumbnail})`,
            backgroundSize: 'cover', backgroundPosition: 'center',
            opacity: 0.7, borderRadius: 12,
          }} />
        )}
        <BlockText boardId={boardId} width={width} />
        <div style={{
          position: 'absolute', bottom: 6, left: 8, zIndex: 2,
          color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: 600,
          textShadow: '0 1px 4px rgba(0,0,0,0.8)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          maxWidth: width - 16,
        }}>
          {displayLabel}
        </div>
      </div>

      {colorPicker && (
        <ColorPickerPopup
          color={rootColor}
          anchorX={colorPicker.x}
          anchorY={colorPicker.y}
          onChange={c => board.rootIds.forEach(rid => useBoardsStore.getState().setBarColor(boardId, rid, c))}
          onClose={() => setColorPicker(null)}
        />
      )}

      {blockMenu && ReactDOM.createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onPointerDown={() => setBlockMenu(null)} />
          <div
            onPointerDown={e => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: Math.min(blockMenu.x, window.innerWidth - 180),
              top: Math.min(blockMenu.y, window.innerHeight - 220),
              width: 180, zIndex: 9999,
              background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
              padding: '5px 0', fontFamily: 'system-ui, sans-serif',
            }}
          >
            <div style={{ padding: '4px 12px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', marginBottom: 4 }}>
              <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>Block Layer</span>
            </div>
            {[
              { label: 'Set Color', icon: '🎨', action: () => { setColorPicker({ x: blockMenu.x, y: blockMenu.y }); setBlockMenu(null) } },
              { label: 'Set Label', icon: '✏️', action: () => {
                const val = prompt('Block label:', board.layers?.block?.label || board.projectName)
                if (val !== null) useBoardsStore.getState().setBlockLabel(boardId, val)
                setBlockMenu(null)
              }},
              ...(thumbnail ? [{ label: 'Remove Thumbnail', icon: '🖼', action: () => {
                useUndoCoordinator.getState().checkpoint()
                useBoardsStore.getState().setBlockThumbnail(boardId, null)
                setBlockMenu(null)
              }}] : []),
              ...(boardId !== 'primary' ? [{ label: 'Duplicate Board', icon: '📋', action: () => {
                useUndoCoordinator.getState().checkpoint()
                useBoardsStore.getState().duplicateBoard(boardId)
                setBlockMenu(null)
              }}] : []),
              { label: 'Move to New Group', icon: '📦', action: () => {
                useUndoCoordinator.getState().checkpoint()
                useBoardsStore.getState().moveToNewGroup(boardId)
                setBlockMenu(null)
              }},
              ...otherGroups.map(g => ({
                label: `→ ${g.name}`, icon: '↗️', action: () => {
                  useUndoCoordinator.getState().checkpoint()
                  useBoardsStore.getState().reassignBoard(boardId, g.id)
                  setBlockMenu(null)
                }
              })),
            ].map(item => (
              <button
                key={item.label}
                onClick={item.action}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9,
                  width: '100%', padding: '7px 14px',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: '#e2e8f0', fontSize: 13, textAlign: 'left', borderRadius: 4,
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'none')}
              >
                <span style={{ fontSize: 14, width: 18, textAlign: 'center' }}>{item.icon}</span>
                {item.label}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </div>
  )
}

// ── Canvas content ──

const Canvas: React.FC = () => {
  const boardOrder = useBoardsStore(s => s.boardOrder)
  return (
    <>
      <FreeCanvas />
      <BlockItem boardId="primary" />
      {boardOrder.map(id => <BlockItem key={id} boardId={id} />)}
    </>
  )
}

// ── Screen-space overlay ──

const Overlay: React.FC = () => {
  const groups = useBoardsStore(s => s.groups)
  return (
    <>
      {groups.map(g => (
        <NLETimelineHeader key={g.id} groupId={g.id} />
      ))}
    </>
  )
}

// ── Block-level independent text (double-click to edit) ──
const vAlignToJustify = (va: string) => va === 'middle' ? 'center' : va === 'bottom' ? 'flex-end' : 'flex-start'

const BlockText: React.FC<{ boardId: string; width: number }> = ({ boardId }) => {
  const bodyText = useBoardsStore(s => s.boards[boardId]?.layers?.block?.text ?? '')
  const rawBodyStyle = useBoardsStore(s => s.boards[boardId]?.layers?.block?.textStyle)
  const bodyTs: TextStyle = useMemo(() => ({ ...DEFAULT_BODY_STYLE, ...rawBodyStyle }), [rawBodyStyle])

  const headerText = useBoardsStore(s => s.boards[boardId]?.layers?.block?.headerText ?? '')
  const rawHeaderStyle = useBoardsStore(s => s.boards[boardId]?.layers?.block?.headerTextStyle)
  const headerTs: TextStyle = useMemo(() => ({ ...DEFAULT_BLOCK_HEADER_STYLE, ...rawHeaderStyle }), [rawHeaderStyle])
  ensureFontLoaded(headerTs.fontFamily); ensureFontLoaded(bodyTs.fontFamily)

  const [editingField, setEditingField] = useState<'header' | 'body' | null>(null)
  const [activeField, setActiveField] = useState<TextFieldMode>('header')
  const [selected, setSelected] = useState(false)
  const [headerVal, setHeaderVal] = useState('')
  const [bodyVal, setBodyVal] = useState('')
  const wrapperRef = useRef<HTMLDivElement>(null)
  const headerRef = useRef<HTMLTextAreaElement>(null)
  const bodyRef = useRef<HTMLTextAreaElement>(null)

  const headerBg = hexToRgba(headerTs.bgColor, headerTs.bgOpacity)
  const bodyBg = hexToRgba(bodyTs.bgColor, bodyTs.bgOpacity)
  const rect = selected && wrapperRef.current ? wrapperRef.current.getBoundingClientRect() : null

  const commitHeader = useCallback(() => {
    useBoardsStore.getState().setBlockHeaderText(boardId, headerVal)
    setEditingField(null)
  }, [boardId, headerVal])

  const commitBody = useCallback(() => {
    useBoardsStore.getState().setBlockText(boardId, bodyVal)
    setEditingField(null)
  }, [boardId, bodyVal])

  const startEditHeader = useCallback(() => {
    setHeaderVal(headerText); setEditingField('header'); setActiveField('header'); setSelected(true)
  }, [headerText])

  const startEditBody = useCallback(() => {
    setBodyVal(bodyText); setEditingField('body'); setActiveField('body'); setSelected(true)
  }, [bodyText])

  // Listen for parent's double-click to start editing even when empty
  React.useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const handler = () => startEditHeader()
    el.addEventListener('start-edit', handler)
    return () => el.removeEventListener('start-edit', handler)
  }, [startEditHeader])

  // When H/P mode switches, focus the corresponding textarea
  React.useEffect(() => {
    if (!selected) return
    if (activeField === 'header' && editingField !== 'header') {
      startEditHeader()
    } else if (activeField === 'body' && editingField !== 'body') {
      startEditBody()
    }
  }, [activeField]) // eslint-disable-line react-hooks/exhaustive-deps

  const textareaStyle = (ts: TextStyle, bg: string): React.CSSProperties => ({
    width: '100%', padding: 8, boxSizing: 'border-box',
    background: bg || 'transparent',
    color: ts.color, fontSize: ts.fontSize, lineHeight: 1.4,
    fontWeight: ts.bold ? 700 : 400, fontStyle: ts.italic ? 'italic' : 'normal',
    textAlign: ts.align,
    border: '1px solid rgba(100,160,255,0.5)', borderRadius: 8,
    outline: 'none', resize: 'none', fontFamily: ts.fontFamily || 'inherit',
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    cursor: 'text',
  })

  const displayStyle = (ts: TextStyle, bg: string, hasText: boolean): React.CSSProperties => ({
    padding: hasText ? 8 : 0,
    background: hasText ? bg : 'transparent',
    borderRadius: 6,
    color: ts.color, fontSize: ts.fontSize, lineHeight: 1.4,
    fontWeight: ts.bold ? 700 : 400, fontStyle: ts.italic ? 'italic' : 'normal',
    textAlign: ts.align, fontFamily: ts.fontFamily || 'inherit',
    overflow: 'hidden', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    textShadow: hasText ? '0 1px 4px rgba(0,0,0,0.8)' : 'none',
  })

  return (
    <div ref={wrapperRef} data-block-text style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none' }}>
      {selected && (
        <TextFormatToolbar
          headerStyle={headerTs}
          bodyStyle={bodyTs}
          onHeaderStyleChange={style => useBoardsStore.getState().setBlockHeaderTextStyle(boardId, style)}
          onBodyStyleChange={style => useBoardsStore.getState().setBlockTextStyle(boardId, style)}
          activeField={activeField}
          onActiveFieldChange={setActiveField}
          anchorRect={rect}
          preferBelow
        />
      )}
      <div
        style={{
          position: 'absolute', inset: 0, padding: 4,
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          pointerEvents: editingField ? 'auto' : 'none',
        }}
        onPointerDown={e => { if (editingField) e.stopPropagation() }}
        onBlur={e => {
          const related = e.relatedTarget as HTMLElement | null
          if (related?.closest('[data-text-format-toolbar]')) return
          if (e.currentTarget.contains(e.relatedTarget as Node)) return
          if (editingField === 'header') commitHeader()
          if (editingField === 'body') commitBody()
          setSelected(false); setEditingField(null)
        }}
        tabIndex={0}
      >
        {/* Header area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: vAlignToJustify(headerTs.vAlign), minHeight: 0 }}>
          {editingField === 'header' ? (
            <textarea
              ref={headerRef}
              autoFocus
              value={headerVal}
              onChange={e => setHeaderVal(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { commitHeader(); setSelected(false) }
                if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); commitHeader(); startEditBody() }
              }}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setActiveField('header') }}
              placeholder="Title…"
              style={{ ...textareaStyle(headerTs, headerBg || 'rgba(0,0,0,0.3)'), flex: 1 }}
            />
          ) : (
            headerText ? (
              <div
                style={{ ...displayStyle(headerTs, headerBg, true), pointerEvents: 'auto', cursor: 'text' }}
                onDoubleClick={e => { e.stopPropagation(); startEditHeader() }}
              >
                {headerText}
              </div>
            ) : null
          )}
        </div>
        {/* Body area */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: vAlignToJustify(bodyTs.vAlign), minHeight: 0 }}>
          {editingField === 'body' ? (
            <textarea
              ref={bodyRef}
              autoFocus
              value={bodyVal}
              onChange={e => setBodyVal(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Escape') { commitBody(); setSelected(false) }
                if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); commitBody(); startEditHeader() }
              }}
              onPointerDown={e => e.stopPropagation()}
              onClick={e => { e.stopPropagation(); setActiveField('body') }}
              placeholder="Body text…"
              style={{ ...textareaStyle(bodyTs, bodyBg || 'rgba(0,0,0,0.3)'), flex: 1 }}
            />
          ) : (
            bodyText ? (
              <div
                style={{ ...displayStyle(bodyTs, bodyBg, true), pointerEvents: 'auto', cursor: 'text' }}
                onDoubleClick={e => { e.stopPropagation(); startEditBody() }}
              >
                {bodyText}
              </div>
            ) : null
          )}
        </div>
      </div>
    </div>
  )
}

export const BlockLayer = { Canvas, Overlay }
