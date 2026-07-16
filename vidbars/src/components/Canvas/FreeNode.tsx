import React, { useState, useRef, useCallback, useEffect } from 'react'
import ReactDOM from 'react-dom'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import type { FreeNodeData, TextStyle } from '../../store/freeNodeStore'
import { DEFAULT_TEXT_STYLE } from '../../store/freeNodeStore'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import {
  ensureFontLoaded, FONT_LIST, loadGoogleFont, hexToRgba,
  FONT_SIZES, FONT_WEIGHTS, LINE_HEIGHTS, LETTER_SPACINGS, TEXT_TRANSFORMS, PRESET_COLORS,
  hAlignIcons, vAlignIcons, AlignPopup, ColorSwatchPopup, BgPickerPopup,
} from '../UI/TextFormatToolbar'
import { useBoardsStore } from '../../store/boardsStore'
import type { HeroImageTransform } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useViewport3DStore } from '../../store/viewport3dStore'
import { useMagnetPreviewStore } from '../../store/magnetPreviewStore'
import { findMagnetCandidate, magnetRadiusForZoom, type WindowRect } from '../../utils/viewportDocking'
import { ensureModelPoster, getModelPoster, useModelPoster } from '../../three/posterService'
import { HeroImageEditOverlay } from '../UI/HeroImageEditOverlay'
import { DrawableSurface } from '../Annotation/DrawableSurface'
import { PenButton } from '../Annotation/PenButton'
import { useSeedHoverFromCursor } from '../../utils/pointerTracker'


interface Props {
  id: string
  /** When this model tile's cluster touches a 3D viewport window, the
   *  window's id — enables the connected affordance + click-to-load. */
  connectedWindowId?: string | null
}

export const FreeNode: React.FC<Props> = React.memo(({ id, connectedWindowId = null }) => {
  const node = useFreeNodeStore(s => s.nodes[id])
  const moveFreeNode = useFreeNodeStore(s => s.moveFreeNode)
  const moveManyFreeNodes = useFreeNodeStore(s => s.moveManyFreeNodes)
  const resizeFreeNode = useFreeNodeStore(s => s.resizeFreeNode)
  const updateFreeNode = useFreeNodeStore(s => s.updateFreeNode)
  const deleteFreeNode = useFreeNodeStore(s => s.deleteFreeNode)
  const isSelected = useFreeNodeStore(s => s.selectedIds.includes(id))
  const setFreeSelection = useFreeNodeStore(s => s.setFreeSelection)
  const toggleFreeSelection = useFreeNodeStore(s => s.toggleFreeSelection)
  const zoom = useCanvasStore(s => s.zoom)

  const [isHovered, setIsHovered] = useState(false)
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameVal, setRenameVal] = useState('')
  const [nodeMenu, setNodeMenu] = useState<{ x: number; y: number } | null>(null)
  const [textEditing, setTextEditing] = useState(false)
  const [isEditingImage, setIsEditingImage] = useState(false)

  const renameRef = useRef<HTMLInputElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const dragLastX = useRef(0)
  const dragLastY = useRef(0)
  const dragHasMoved = useRef(false)
  const wasSelectedOnDown = useRef(false)
  const resizeLastX = useRef(0)
  const resizeLastY = useRef(0)

  useEffect(() => { if (isRenaming) renameRef.current?.select() }, [isRenaming])

  // Seed isHovered if the cursor is already over this node when it mounts —
  // covers the "swapped in under stationary cursor" case at zoom-layer
  // transitions (browsers don't fire mouseenter for elements that appear
  // under a cursor that hasn't moved).
  useSeedHoverFromCursor(wrapperRef, setIsHovered)

  // Drag the whole card — anything except textarea/input/button/[data-resize]
  const onNodeDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    const tag = (e.target as HTMLElement).tagName
    if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'BUTTON') return
    if ((e.target as Element).closest('[data-resize]')) return
    if ((e.target as Element).closest('[data-pen-button]')) return
    e.stopPropagation()
    useUndoCoordinator.getState().checkpoint()
    dragLastX.current = e.clientX
    dragLastY.current = e.clientY
    dragHasMoved.current = false
    wrapperRef.current?.setPointerCapture(e.pointerId)
  }, [])

  const onNodeMove = useCallback((e: React.PointerEvent) => {
    if (!wrapperRef.current?.hasPointerCapture(e.pointerId)) return
    const dx = (e.clientX - dragLastX.current) / zoom
    const dy = (e.clientY - dragLastY.current) / zoom
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) dragHasMoved.current = true
    // Move all selected nodes together if this node is part of the selection
    const sel = useFreeNodeStore.getState().selectedIds
    if (sel.length > 1 && sel.includes(id)) {
      moveManyFreeNodes(sel, dx, dy)
    } else {
      moveFreeNode(id, dx, dy)
    }
    dragLastX.current = e.clientX
    dragLastY.current = e.clientY
    // Magnet affordance: model tiles near a viewport window edge show a
    // "will snap here" ghost (dock itself is resolved on release).
    const n = useFreeNodeStore.getState().nodes[id]
    if (n?.mediaType === 'model' && n.imageUrl) {
      const winRects: WindowRect[] = Object.values(useViewport3DStore.getState().windows)
        .map(w => ({ id: w.id, x: w.x, y: w.y, width: w.width, height: w.height }))
      const cand = winRects.length > 0 ? findMagnetCandidate(n, winRects, magnetRadiusForZoom(zoom)) : null
      const mp = useMagnetPreviewStore.getState()
      if (cand) {
        mp.setPreview({ windowId: cand.windowId, edge: cand.edge, x: cand.snapped.x, y: cand.snapped.y, width: n.width, height: n.height })
      } else if (mp.preview) {
        mp.setPreview(null)
      }
    }
  }, [id, moveFreeNode, moveManyFreeNodes, zoom])

  const onNodeUp = useCallback((e: React.PointerEvent) => {
    if (!wrapperRef.current?.hasPointerCapture(e.pointerId)) return
    // Fresh read up front — NOTE: this intentionally shadows the component-
    // scope `node`; declaring it lower created a temporal-dead-zone throw
    // for any reference above the declaration (broke no-drag clicks).
    const node = useFreeNodeStore.getState().nodes[id]
    if (!node) return
    if (!dragHasMoved.current) {
      if (e.shiftKey) toggleFreeSelection(id)
      else {
        // If text node was already selected before this click, single click on body → enter edit
        // Header clicks never reach here (stopPropagation on header div prevents pointer capture)
        if (node.type === 'text' && wasSelectedOnDown.current && !isRenaming) {
          setTextEditing(true)
        }
        setFreeSelection([id])
        // Connected model tile: a plain click also shows its model in the
        // viewport window its cluster touches (in addition to the strip).
        if (node.type === 'model' && connectedWindowId && node.imageUrl) {
          useViewport3DStore.getState().setActiveModel(connectedWindowId, node.imageUrl)
        }
      }
    }
    // Transfer node content to a bar/card on drop
    // Magnet dock: a model tile released near a viewport window edge snaps
    // flush and loads its model. The tile is KEPT (dock membership stays
    // derived from its position) — this outranks the transfer scan below.
    {
      const preview = useMagnetPreviewStore.getState().preview
      if (preview) useMagnetPreviewStore.getState().setPreview(null)
      if (dragHasMoved.current && node?.mediaType === 'model' && preview) {
        const cur = useFreeNodeStore.getState().nodes[id]
        if (cur) updateFreeNode(id, { x: preview.x, y: preview.y })
        if (node.imageUrl) useViewport3DStore.getState().setActiveModel(preview.windowId, node.imageUrl)
        return
      }
    }
    if (dragHasMoved.current && node) {
      const hasMedia = !!node.imageUrl
      const hasText = !!(node.text && (node.type === 'text' || node.type === 'note'))
      if (hasMedia || hasText) {
        wrapperRef.current!.style.pointerEvents = 'none'
        const allEls = document.elementsFromPoint(e.clientX, e.clientY)
        wrapperRef.current!.style.pointerEvents = ''

        const mediaType = node.mediaType ?? 'image'

        // Helper: transfer to a specific bar
        const transferToBar = (boardId: string, barId: string) => {
          if (hasMedia && node.imageUrl) {
            const curMedia = useBoardsStore.getState().boards[boardId]?.bars[barId]?.content.media ?? []
            // Models: the poster may live only in the shared map (map-first
            // rendering skips writing node.posterUrl) — carry it either way
            // so bar heroes can show it.
            const posterUrl = node.posterUrl
              ?? (mediaType === 'model' ? getModelPoster(node.imageUrl) : null)
            useBoardsStore.getState().setContent(boardId, barId, {
              media: [...curMedia, {
                url: node.imageUrl, type: mediaType,
                ...(posterUrl ? { posterUrl } : {}),
                ...(node.label ? { originalName: node.label } : {}),
              }],
            })
          }
          if (hasText) {
            const curText = useBoardsStore.getState().boards[boardId]?.bars[barId]?.content.text ?? ''
            const newText = curText ? curText + '\n' + node.text : node.text
            const patch: Record<string, any> = { text: newText }
            // Carry text formatting through if this node has a textStyle
            if (node.textStyle) {
              patch.textStyle = { ...node.textStyle }
            }
            useBoardsStore.getState().setContent(boardId, barId, patch)
          }
          useFreeNodeStore.getState().deleteFreeNode(id)
        }

        // Priority: board-level blocks > block-layer blocks > cards
        let transferred = false
        const curZoom = useCanvasStore.getState().zoom

        // Board zoom (>= 0.3): transfer to specific bar
        for (const el of allEls) {
          const block = el.closest('[data-block][data-id]') as HTMLElement | null
          if (block && !block.dataset.layerBlock) {
            transferToBar(block.dataset.boardId ?? 'primary', block.dataset.id!)
            transferred = true
            break
          }
        }

        // Block zoom (0.17–0.3): transfer to block-level independent text.
        // Model tiles transfer INTO the board's content (root bar media —
        // so the block "has" the model); the thumbnail only ever receives
        // the model's POSTER (a .glb URL in an <img> renders broken), and
        // only when the block has none yet.
        if (!transferred) {
          for (const el of allEls) {
            const block = el.closest('[data-layer-block]') as HTMLElement | null
            if (block) {
              const targetBoardId = block.getAttribute('data-layer-block')!
              if (mediaType === 'model') {
                const b = useBoardsStore.getState().boards[targetBoardId]
                const rootBar = b?.rootIds[0]
                if (!rootBar) break   // no bar to hold the model — leave the tile
                const poster = node.posterUrl ?? (node.imageUrl ? getModelPoster(node.imageUrl) : null)
                if (poster && !b.layers?.block?.thumbnail) {
                  useBoardsStore.getState().setBlockThumbnail(targetBoardId, poster)
                }
                transferToBar(targetBoardId, rootBar)   // appends media + deletes node
                transferred = true
                break
              }
              if (hasText) {
                const curText = useBoardsStore.getState().boards[targetBoardId]?.layers?.block?.text ?? ''
                const newText = curText ? curText + '\n' + node.text : node.text
                useBoardsStore.getState().setBlockText(targetBoardId, newText)
              }
              if (hasMedia && node.imageUrl) {
                useBoardsStore.getState().setBlockThumbnail(targetBoardId, node.imageUrl)
              }
              useFreeNodeStore.getState().deleteFreeNode(id)
              transferred = true
              break
            }
          }
        }

        // Card zoom (≤ 0.17): transfer to card-level independent text.
        // Model tiles transfer INTO the card's content (first board's root
        // bar media — enabling decks of models); the hero only ever gets
        // the model's POSTER, and only when the card has none yet.
        if (!transferred) {
          for (const el of allEls) {
            const card = el.closest('[data-nle-card]') as HTMLElement | null
            if (card) {
              const targetBoardId = card.dataset.nleCard!
              // Check if this is a group card or ungrouped
              const layerCard = card.closest('[data-layer-card]') as HTMLElement | null
              const groupId = layerCard?.getAttribute('data-layer-card')

              if (mediaType === 'model') {
                const bs = useBoardsStore.getState()
                const group = groupId ? bs.groups.find(g => g.id === groupId) : undefined
                const modelBoardId = group ? group.boardIds[0] : targetBoardId
                const rootBar = bs.boards[modelBoardId]?.rootIds[0]
                if (!rootBar) break   // nowhere to hold the model — leave the tile
                const poster = node.posterUrl ?? (node.imageUrl ? getModelPoster(node.imageUrl) : null)
                if (poster) {
                  if (group && !group.cardHeroImage) {
                    bs.setGroupCardHeroImage(group.id, poster)
                  } else if (!group && !bs.boards[targetBoardId]?.layers?.card?.heroImage) {
                    bs.setCardHeroImage(targetBoardId, poster)
                  }
                }
                transferToBar(modelBoardId, rootBar)   // appends media + deletes node
                transferred = true
                break
              }

              if (hasText) {
                if (groupId) {
                  const curText = useBoardsStore.getState().groups.find(g => g.id === groupId)?.cardText ?? ''
                  const newText = curText ? curText + '\n' + node.text : node.text
                  useBoardsStore.getState().setGroupCardText(groupId, newText)
                } else {
                  const curText = useBoardsStore.getState().boards[targetBoardId]?.layers?.card?.text ?? ''
                  const newText = curText ? curText + '\n' + node.text : node.text
                  useBoardsStore.getState().setCardText(targetBoardId, newText)
                }
              }
              if (hasMedia && node.imageUrl) {
                if (groupId) {
                  useBoardsStore.getState().setGroupCardHeroImage(groupId, node.imageUrl)
                } else {
                  useBoardsStore.getState().setCardHeroImage(targetBoardId, node.imageUrl)
                }
              }
              useFreeNodeStore.getState().deleteFreeNode(id)
              transferred = true
              break
            }
          }
        }

        if (transferred) return
      }
    }
    // No transfer happened — user placed the node here intentionally, leave it.
  }, [id, node?.type, node?.imageUrl, connectedWindowId, isSelected, isRenaming, setFreeSelection, toggleFreeSelection])

  // Resize handle
  const onResizeDown = useCallback((e: React.PointerEvent) => {
    e.stopPropagation()
    useUndoCoordinator.getState().checkpoint()
    resizeLastX.current = e.clientX
    resizeLastY.current = e.clientY
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  const onResizeMove = useCallback((e: React.PointerEvent) => {
    if (!(e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) return
    resizeFreeNode(id, (e.clientX - resizeLastX.current) / zoom, (e.clientY - resizeLastY.current) / zoom)
    resizeLastX.current = e.clientX
    resizeLastY.current = e.clientY
  }, [id, resizeFreeNode, zoom])

  const commitRename = useCallback(() => {
    if (renameVal.trim()) updateFreeNode(id, { label: renameVal.trim() })
    setIsRenaming(false)
  }, [id, renameVal, updateFreeNode])


  if (!node) return null

  // Inverse-zoom scaling: keep header text and controls readable at any canvas zoom.
  // At zoom 0.12, a canvas-space value of X appears as X*0.12 on screen,
  // so we scale up by 1/zoom to maintain roughly constant screen-pixel sizes.
  const iz = 1 / zoom
  // Damped inverse-zoom: sqrt(1/zoom). Shrinks more gently than linear zoom,
  // grows more gently than full iz. Used for body content (text, icons, waveforms).
  const dz = 1 / Math.sqrt(zoom)
  const headerH = 20 * iz
  const fontSize = 11 * iz               // ~11px on screen at any zoom
  const dotSize  = 5 * iz
  const pad      = 6 * iz
  const borderW  = Math.max(1, 2 / zoom)

  return (
    <div
      ref={wrapperRef}
      data-freenode="true"
      data-id={id}
      style={{
        position: 'absolute',
        left: node.x,
        top: node.y,
        width: node.width,
        height: node.height,
        borderRadius: 10 / zoom,
        background: node.color,
        // Connected-to-viewport model tiles carry the accent tint — the
        // same "these things are linked" language as touching deck cards.
        border: `${borderW}px solid ${connectedWindowId
          ? `rgba(120,170,255,${isHovered ? 0.65 : 0.45})`
          : `rgba(255,255,255,${isHovered ? 0.18 : 0.08})`}`,
        boxShadow: isSelected
          ? `0 0 0 ${2.5 / zoom}px rgba(120,180,255,0.9), 0 ${8 / zoom}px ${32 / zoom}px rgba(0,0,0,0.55)`
          : isHovered ? `0 ${8 / zoom}px ${32 / zoom}px rgba(0,0,0,0.55)` : `0 ${2 / zoom}px ${12 / zoom}px rgba(0,0,0,0.4)`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'border-color 0.12s, box-shadow 0.12s',
        zIndex: isHovered ? 50 : 5,
        cursor: 'grab',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onPointerDownCapture={e => {
        // Select node in capture phase so children with stopPropagation (note textarea) don't block selection
        if (e.button !== 0) return
        if ((e.target as Element).closest('[data-resize]')) return
        wasSelectedOnDown.current = isSelected
        if (e.shiftKey) { toggleFreeSelection(id) }
        else if (!isSelected) { setFreeSelection([id]) }
      }}
      onPointerDown={onNodeDown}
      onPointerMove={onNodeMove}
      onPointerUp={onNodeUp}
      onDoubleClick={e => {
        if (dragHasMoved.current) return
        // Header label has its own dblclick handler for rename.
        // For text nodes, double-click on body → trigger text edit.
        // Header clicks don't reach here (stopPropagation on header div).
        if (node.type === 'text' && !isRenaming) {
          setTextEditing(true)
          setFreeSelection([id])
        }
      }}
      onContextMenu={e => {
        e.preventDefault(); e.stopPropagation()
        setNodeMenu({ x: e.clientX, y: e.clientY })
      }}
    >
      {/* ── Header ── */}
      <div data-freenode-header onPointerDown={e => e.stopPropagation()} style={{
        display: 'flex', alignItems: 'center', gap: 6 * iz,
        padding: `${pad * 0.6}px ${pad}px`,
        background: 'rgba(0,0,0,0.3)',
        borderBottom: `${borderW}px solid rgba(255,255,255,0.06)`,
        flexShrink: 0, height: headerH,
      }}>
        {node.type === 'text' ? (
          <span style={{ fontSize: fontSize * 0.9, fontWeight: 800, color: 'rgba(255,255,255,0.4)', lineHeight: 1, flexShrink: 0 }}>T</span>
        ) : node.type === 'video' ? (
          <span style={{ fontSize: fontSize * 0.75, color: 'rgba(255,255,255,0.35)', lineHeight: 1, flexShrink: 0 }}>▶</span>
        ) : node.type === 'audio' ? (
          <span style={{ fontSize: fontSize * 0.75, color: 'rgba(255,255,255,0.35)', lineHeight: 1, flexShrink: 0 }}>♪</span>
        ) : node.type === 'model' ? (
          <span style={{ fontSize: fontSize * 0.75, color: connectedWindowId ? 'rgba(140,190,255,0.9)' : 'rgba(255,255,255,0.35)', lineHeight: 1, flexShrink: 0 }}>◆</span>
        ) : (
          <div style={{ width: dotSize, height: dotSize, borderRadius: '50%', background: 'rgba(255,255,255,0.22)', flexShrink: 0 }} />
        )}

        {/* Annotation toggle — placed LEFT of the label so it doesn't crowd
                the right-edge resize-corner zone or any future trailing
                affordances on the header. Hover-only reveal keeps the header
                clean by default; the button fades in once the node is
                pointer-engaged (matches X / grip patterns elsewhere). */}
        <span data-pen-button="true" style={{ display: 'inline-flex', flexShrink: 0 }}>
          <PenButton
            surface={{ kind: 'freeNode', nodeId: id }}
            baseColor={node.color}
            size={Math.max(14, 14 * iz)}
            visible={isHovered}
          />
        </span>

        {isRenaming ? (
          <input
            ref={renameRef}
            value={renameVal}
            onChange={e => setRenameVal(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setIsRenaming(false) }}
            onPointerDown={e => e.stopPropagation()}
            style={{
              flex: 1, background: 'rgba(255,255,255,0.06)', border: 'none',
              borderBottom: `${Math.max(1, borderW)}px solid rgba(255,255,255,0.3)`,
              borderRadius: 0, outline: 'none', color: '#fff',
              fontSize, fontWeight: 600, lineHeight: 1.2, padding: 0, fontFamily: 'inherit',
              boxSizing: 'border-box', minWidth: 0,
            }}
          />
        ) : (
          <span
            style={{
              flex: 1, color: 'rgba(255,255,255,0.65)', fontSize, fontWeight: 600,
              userSelect: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
            onDoubleClick={e => { e.stopPropagation(); setRenameVal(node.label); setIsRenaming(true) }}
          >{node.label}</span>
        )}
      </div>

      {/* ── Body ── */}
      <FreeNodeBody node={node} id={id} iz={iz} dz={dz} pad={pad} updateFreeNode={updateFreeNode} isEditing={textEditing} setIsEditing={setTextEditing} />

      {/* ── Annotation layer — overlays the body region only (header excluded).
              Always renders saved strokes; captures pointer events only while
              draw mode targets THIS node. */}
      <div style={{
        position: 'absolute',
        top: headerH,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',  // children opt-in via DrawableSurface's own gate
      }}>
        <DrawableSurface
          surface={{ kind: 'freeNode', nodeId: id }}
          width={node.width}
          height={Math.max(0, node.height - headerH)}
          strokes={node.strokes ?? []}
        />
      </div>

      {/* ── Text format toolbar (shown when text node is selected) ── */}
      {node.type === 'text' && isSelected && (
        <TextFormatToolbar node={node} id={id} updateFreeNode={updateFreeNode} wrapperRef={wrapperRef} />
      )}

      {/* ── Resize handle — large corner zone, always present ── */}
      <div
        data-resize="true"
        style={{
          position: 'absolute', bottom: 0, right: 0,
          width: 40 * iz, height: 40 * iz,
          cursor: 'nwse-resize',
          zIndex: 20,
          display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
          padding: `0 ${5 * iz}px ${5 * iz}px 0`,
        }}
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
      >
        {/* Visual grip dots */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: `repeat(3, ${3 * iz}px)`,
          gridTemplateRows: `repeat(3, ${3 * iz}px)`,
          gap: `${2 * iz}px`,
          opacity: isHovered ? 0.5 : 0.15,
          transition: 'opacity 0.12s',
        }}>
          {[...Array(9)].map((_, i) => (
            <div key={i} style={{
              width: 3 * iz, height: 3 * iz, borderRadius: '50%',
              background: 'rgba(255,255,255,0.9)',
              opacity: (i === 4 || i < 3) ? 0 : 1,
            }} />
          ))}
        </div>
      </div>

      {/* ── Context menu ── */}
      {nodeMenu && ReactDOM.createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onPointerDown={() => setNodeMenu(null)} />
          <div
            onPointerDown={e => e.stopPropagation()}
            style={{
              position: 'fixed',
              left: Math.min(nodeMenu.x, window.innerWidth - 180),
              top: Math.min(nodeMenu.y, window.innerHeight - 200),
              width: 170, zIndex: 9999,
              background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.6)',
              padding: '5px 0', fontFamily: 'system-ui, sans-serif',
            }}
          >
            <div style={{ padding: '4px 12px 6px', borderBottom: '1px solid rgba(255,255,255,0.07)', marginBottom: 4 }}>
              <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 11 }}>{node.label}</span>
            </div>
            {[
              { label: 'Rename', icon: '✏️', action: () => { setRenameVal(node.label); setIsRenaming(true); setNodeMenu(null) } },
              ...(node.imageUrl && node.mediaType !== 'model' ? [
                { label: 'Edit Image', icon: '✂️', action: () => { setNodeMenu(null); setIsEditingImage(true) } },
                { label: 'Remove Image', icon: '🖼', action: () => { useUndoCoordinator.getState().checkpoint(); updateFreeNode(id, { imageUrl: null, imageTransform: undefined }); setNodeMenu(null) } },
              ] : []),
              ...(node.imageUrl && node.mediaType === 'model' ? [
                { label: 'Remove Model', icon: '◆', action: () => { useUndoCoordinator.getState().checkpoint(); updateFreeNode(id, { imageUrl: null, posterUrl: undefined }); setNodeMenu(null) } },
              ] : []),
              { label: 'Delete', icon: '🗑️', danger: true, action: () => { useUndoCoordinator.getState().checkpoint(); deleteFreeNode(id); setNodeMenu(null) } },
            ].map(item => (
              <button
                key={item.label}
                onClick={item.action}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9,
                  width: '100%', padding: '7px 14px',
                  background: 'none', border: 'none', cursor: 'pointer',
                  color: ('danger' in item && item.danger) ? '#f87171' : '#e2e8f0',
                  fontSize: 13, textAlign: 'left', borderRadius: 4,
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
      {isEditingImage && node.imageUrl && (() => {
        const r = wrapperRef.current?.getBoundingClientRect()
        if (!r) return null
        return (
          <HeroImageEditOverlay
            cardRect={{ left: r.left, top: r.top, width: r.width, height: r.height }}
            heroImage={node.imageUrl}
            initialTransform={node.imageTransform ?? { scale: 1, offsetX: 0, offsetY: 0, flipH: false, flipV: false }}
            onDone={t => {
              useUndoCoordinator.getState().checkpoint()
              updateFreeNode(id, { imageTransform: t })
              setIsEditingImage(false)
            }}
            onCancel={() => setIsEditingImage(false)}
          />
        )
      })()}
    </div>
  )
})

// ── Body renderer for each node type ──

const FreeNodeBody: React.FC<{
  node: FreeNodeData
  id: string
  iz: number
  dz: number
  pad: number
  updateFreeNode: (id: string, patch: Partial<FreeNodeData>) => void
  isEditing: boolean
  setIsEditing: (v: boolean) => void
}> = ({ node, id, iz, dz, pad, updateFreeNode, isEditing, setIsEditing }) => {
  const textRef = useRef<HTMLTextAreaElement>(null)
  // node.imageUrl may be a `mediaref:` pointer — resolve to a usable URL
  // (null while loading / if missing). Called unconditionally before any
  // early return to keep hook order stable.
  const resolvedUrl = useResolvedMedia(node.imageUrl)

  useEffect(() => { if (isEditing) textRef.current?.focus() }, [isEditing])

  // ── Model type: poster thumbnail + 3D badge (never renders the .glb) ──
  if (node.type === 'model') {
    return <ModelTileBody node={node} id={id} dz={dz} updateFreeNode={updateFreeNode} />
  }

  // ── Note type: always-editable textarea ──
  if (node.type === 'note') {
    return (
      <textarea
        value={node.text}
        onChange={e => updateFreeNode(id, { text: e.target.value })}
        onPointerDown={e => e.stopPropagation()}
        placeholder="Type a note…"
        style={{
          flex: 1, background: 'none', border: 'none', outline: 'none',
          color: 'rgba(255,255,255,0.8)',
          fontSize: 12 * iz, lineHeight: 1.55,
          padding: `${8 * iz}px ${pad}px ${28 * iz}px`,
          resize: 'none', fontFamily: 'inherit', cursor: 'text',
        }}
      />
    )
  }

  // ── Text type: view/edit toggle with formatting ──
  if (node.type === 'text') {
    const ts = { ...DEFAULT_TEXT_STYLE, ...node.textStyle }
    ensureFontLoaded(ts.fontFamily)
    const bgRgba = hexToRgba(ts.bgColor, ts.bgOpacity)

    // Fixed canvas-space size: text scales 1:1 with the node box via the canvas
    // transform: scale(zoom). No inverse-zoom compensation — text never reflows.
    const renderFontSize = ts.fontSize
    const renderPad = 6

    const resolvedWeight = ts.fontWeight ?? (ts.bold ? 700 : 400)
    const resolvedLH = ts.lineHeight ?? 1.55
    const resolvedLS = ts.letterSpacing ?? 0
    const resolvedTT = ts.textTransform ?? 'none'

    const textCss: React.CSSProperties = {
      fontSize: renderFontSize,
      lineHeight: resolvedLH,
      fontWeight: resolvedWeight,
      fontStyle: ts.italic ? 'italic' : 'normal',
      textAlign: ts.align,
      fontFamily: ts.fontFamily || 'inherit',
      letterSpacing: resolvedLS,
      textTransform: resolvedTT,
      wordBreak: 'break-word',
    }

    if (isEditing) {
      return (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', position: 'relative' }}>
          <textarea
            ref={textRef}
            value={node.text}
            onChange={e => updateFreeNode(id, { text: e.target.value })}
            onPointerDown={e => e.stopPropagation()}
            onBlur={() => setIsEditing(false)}
            onKeyDown={e => { if (e.key === 'Escape') setIsEditing(false) }}
            placeholder="Type text content…"
            style={{
              ...textCss,
              flex: 1, background: bgRgba, border: 'none', outline: 'none',
              color: ts.color,
              padding: renderPad,
              resize: 'none', cursor: 'text',
            }}
          />
        </div>
      )
    }
    return (
      <div
        style={{
          ...textCss,
          flex: 1, padding: renderPad,
          background: bgRgba,
          color: node.text ? ts.color : 'rgba(255,255,255,0.25)',
          whiteSpace: 'pre-wrap', overflow: 'hidden',
          cursor: 'pointer',
          display: 'flex', flexDirection: 'column',
          justifyContent: ts.vAlign === 'middle' ? 'center' : ts.vAlign === 'bottom' ? 'flex-end' : 'flex-start',
        }}
      >
        <div>{node.text || 'Double-click to edit…'}</div>
      </div>
    )
  }

  // ── Video type: image with play overlay ──
  if (node.type === 'video') {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
        {resolvedUrl ? (
          <>
            <img src={resolvedUrl} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            {/* Play button overlay */}
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: 'rgba(0,0,0,0.25)',
            }}>
              <div style={{
                width: 40 * dz, height: 40 * dz, borderRadius: '50%',
                background: 'rgba(0,0,0,0.6)', border: `${2 * dz}px solid rgba(255,255,255,0.5)`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <div style={{
                  width: 0, height: 0,
                  borderTop: `${8 * dz}px solid transparent`,
                  borderBottom: `${8 * dz}px solid transparent`,
                  borderLeft: `${14 * dz}px solid rgba(255,255,255,0.9)`,
                  marginLeft: 3 * dz,
                }} />
              </div>
            </div>
          </>
        ) : (
          <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.25)', pointerEvents: 'none' }}>
            <div style={{ fontSize: 28 * dz, marginBottom: 4 * dz }}>▶</div>
            <div style={{ fontSize: 10 * dz }}>drop video here</div>
          </div>
        )}
      </div>
    )
  }

  // ── Audio type: waveform skeleton + transport ──
  if (node.type === 'audio') {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: `${6 * dz}px ${pad}px`, gap: 4 * dz }}>
        {/* Filename */}
        <div style={{ fontSize: 10 * dz, color: 'rgba(255,255,255,0.5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.label || 'Audio'}
        </div>
        {/* Fake waveform */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 1 * dz, minHeight: 24 * dz }}>
          {Array.from({ length: 40 }, (_, i) => {
            const h = (Math.sin(i * 0.7) * 0.4 + 0.5 + Math.sin(i * 1.9) * 0.2) * 100
            return (
              <div key={i} style={{
                flex: 1, height: `${Math.max(8, h)}%`,
                background: node.imageUrl ? 'rgba(100,200,255,0.5)' : 'rgba(255,255,255,0.15)',
                borderRadius: 1 * dz,
              }} />
            )
          })}
        </div>
        {/* Transport controls */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 * dz, padding: `${2 * dz}px 0` }}>
          <div style={{ fontSize: 10 * dz, color: 'rgba(255,255,255,0.35)', cursor: 'pointer' }}>⏮</div>
          <div style={{
            width: 22 * dz, height: 22 * dz, borderRadius: '50%',
            background: 'rgba(255,255,255,0.1)', border: `${1.5 * dz}px solid rgba(255,255,255,0.25)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
          }}>
            <div style={{
              width: 0, height: 0,
              borderTop: `${4 * dz}px solid transparent`,
              borderBottom: `${4 * dz}px solid transparent`,
              borderLeft: `${7 * dz}px solid rgba(255,255,255,0.7)`,
              marginLeft: 2 * dz,
            }} />
          </div>
          <div style={{ fontSize: 10 * dz, color: 'rgba(255,255,255,0.35)', cursor: 'pointer' }}>⏭</div>
          <div style={{ flex: 1 }} />
          <div style={{ fontSize: 9 * dz, color: 'rgba(255,255,255,0.3)' }}>0:00 / 0:00</div>
        </div>
      </div>
    )
  }

  // ── Image type (default) ──
  const imgT = node.imageTransform
  const imgFlips: string[] = []
  if (imgT?.flipH) imgFlips.push('scaleX(-1)')
  if (imgT?.flipV) imgFlips.push('scaleY(-1)')
  const hasImgTransform = imgT && (imgT.scale !== 1 || imgT.offsetX !== 0 || imgT.offsetY !== 0 || imgT.flipH || imgT.flipV)
  const imgStyle: React.CSSProperties = hasImgTransform ? {
    width: `${imgT.scale * 100}%`, height: `${imgT.scale * 100}%`,
    objectFit: 'cover',
    objectPosition: `${50 + imgT.offsetX}% ${50 + imgT.offsetY}%`,
    transform: imgFlips.length > 0 ? imgFlips.join(' ') : undefined,
    position: 'absolute',
    left: `${50 - imgT.scale * 50}%`,
    top: `${50 - imgT.scale * 50}%`,
  } : { width: '100%', height: '100%', objectFit: 'cover' as const, transform: imgFlips.length > 0 ? imgFlips.join(' ') : undefined }

  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
      {resolvedUrl ? (
        <img src={resolvedUrl} draggable={false} style={imgStyle} />
      ) : (
        <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.18)', pointerEvents: 'none' }}>
          <div style={{ fontSize: 22 * iz, marginBottom: 5 * iz, opacity: 0.5 }}>⬛</div>
          <div style={{ fontSize: 10 * iz }}>drop image here</div>
        </div>
      )}
    </div>
  )
}

// ── Model tile body: poster image (mediaref:, lazily generated by the
//    poster service once a renderer exists) + "3D" corner badge; wireframe
//    cube + filename until a poster is available. The raw model URL is
//    NEVER fed to an <img>. ──
const ModelTileBody: React.FC<{
  node: FreeNodeData
  id: string
  dz: number
  updateFreeNode: (id: string, patch: Partial<FreeNodeData>) => void
}> = ({ node, id, dz, updateFreeNode }) => {
  // MAP-first poster: the persisted url→poster map is the source of truth
  // (its version bump invalidates stale renders); node.posterUrl is the
  // durable/transfer copy and the fallback while the map refills.
  const mapPoster = useModelPoster(node.imageUrl ?? null)
  const resolvedPoster = useResolvedMedia(mapPoster ?? node.posterUrl ?? null)
  // Lazy generation whenever the MAP lacks this model (first ever render,
  // or after a poster-version migration cleared it); syncs the fresh ref
  // onto the node. Null result (renderer not ready / load failure) just
  // retries on a later mount.
  useEffect(() => {
    if (!node.imageUrl || mapPoster) return
    let live = true
    ensureModelPoster(node.imageUrl)
      .then(ref => { if (live && ref && ref !== node.posterUrl) updateFreeNode(id, { posterUrl: ref }) })
      .catch(() => {})
    return () => { live = false }
  }, [node.imageUrl, mapPoster, node.posterUrl, id, updateFreeNode])
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
      {resolvedPoster ? (
        <img src={resolvedPoster} draggable={false} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.25)', pointerEvents: 'none', maxWidth: '90%' }}>
          {/* Wireframe cube */}
          <svg width={34 * dz} height={34 * dz} viewBox="0 0 24 24" fill="none" style={{ opacity: 0.6, marginBottom: 4 * dz }}>
            <path d="M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z" stroke="rgba(255,255,255,0.5)" strokeWidth="1.2" strokeLinejoin="round" />
            <path d="M12 2 L12 12 M12 12 L21 7 M12 12 L3 7 M12 12 L12 22" stroke="rgba(255,255,255,0.3)" strokeWidth="1" strokeLinejoin="round" />
          </svg>
          <div style={{ fontSize: 10 * dz, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {node.imageUrl ? (node.label || '3D model') : 'drop 3D model here'}
          </div>
        </div>
      )}
      {/* "3D" corner badge — mirrors the video play-overlay affordance */}
      {node.imageUrl && (
        <div style={{
          position: 'absolute', top: 5 * dz, right: 5 * dz,
          padding: `${2 * dz}px ${5 * dz}px`, borderRadius: 4 * dz,
          background: 'rgba(0,0,0,0.55)', border: `${1 * dz}px solid rgba(255,255,255,0.25)`,
          fontSize: 9 * dz, fontWeight: 700, letterSpacing: '0.5px',
          color: 'rgba(160,210,255,0.9)', pointerEvents: 'none',
        }}>3D</div>
      )}
    </div>
  )
}

// ── Text Format Toolbar (portalled above the node) ──

const PRESET_BG_COLORS = ['#000000', '#1e1b4b', '#1e3a2f', '#3b1520', '#1e293b', '#transparent']

const TextFormatToolbar: React.FC<{
  node: FreeNodeData
  id: string
  updateFreeNode: (id: string, patch: Partial<FreeNodeData>) => void
  wrapperRef: React.RefObject<HTMLDivElement | null>
}> = ({ node, id, updateFreeNode, wrapperRef }) => {
  const zoom = useCanvasStore(s => s.zoom)
  const pan = useCanvasStore(s => s.pan)
  const selectedIds = useFreeNodeStore(s => s.selectedIds)
  const allNodes = useFreeNodeStore(s => s.nodes)
  const [showPopup, setShowPopup] = useState<'text' | 'bg' | 'hAlign' | 'vAlign' | 'font' | 'weight' | 'lineHeight' | 'spacing' | 'transform' | null>(null)

  const ts = { ...DEFAULT_TEXT_STYLE, ...node.textStyle }
  const setStyle = (patch: Partial<TextStyle>) => {
    // Apply to all selected text nodes, not just this one
    const textIds = selectedIds.filter(sid => allNodes[sid]?.type === 'text')
    if (textIds.length > 1) {
      for (const sid of textIds) {
        const sNode = allNodes[sid]
        if (sNode) {
          updateFreeNode(sid, { textStyle: { ...DEFAULT_TEXT_STYLE, ...sNode.textStyle, ...patch } })
        }
      }
    } else {
      updateFreeNode(id, { textStyle: { ...ts, ...patch } })
    }
  }

  // Position toolbar above the node in screen coordinates
  const rect = wrapperRef.current?.getBoundingClientRect()
  if (!rect) return null

  const toolbarLeft = rect.left
  const toolbarTop = rect.top - 38

  const btnStyle = (active?: boolean): React.CSSProperties => ({
    background: active ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)',
    border: active ? '1px solid rgba(255,255,255,0.3)' : '1px solid rgba(255,255,255,0.08)',
    borderRadius: 5,
    color: active ? '#fff' : 'rgba(255,255,255,0.6)',
    fontSize: 12, fontWeight: active ? 700 : 500,
    padding: '2px 7px', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minWidth: 24, height: 26,
    transition: 'all 0.1s',
  })

  const sepStyle: React.CSSProperties = {
    width: 1, height: 18, background: 'rgba(255,255,255,0.08)', margin: '0 3px', flexShrink: 0,
  }

  return ReactDOM.createPortal(
    <div
      onPointerDown={e => e.stopPropagation()}
      style={{
        position: 'fixed',
        left: Math.max(4, Math.min(toolbarLeft, window.innerWidth - 460)),
        top: Math.max(4, toolbarTop),
        zIndex: 10000,
        display: 'flex', alignItems: 'center', gap: 3,
        background: '#1a1b2e',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 8, padding: '4px 6px',
        boxShadow: '0 8px 30px rgba(0,0,0,0.7)',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Font size — editable input + steppers */}
      <button style={btnStyle()} onClick={() => {
        const cur = ts.fontSize
        const prev = FONT_SIZES.filter(s => s < cur).pop() ?? Math.max(1, cur - 1)
        setStyle({ fontSize: prev })
      }}>−</button>
      <input
        type="text"
        value={ts.fontSize}
        onChange={e => {
          const v = parseInt(e.target.value, 10)
          if (!isNaN(v) && v > 0 && v <= 999) setStyle({ fontSize: v })
        }}
        onPointerDown={e => e.stopPropagation()}
        onKeyDown={e => {
          if (e.key === 'ArrowUp') { e.preventDefault(); setStyle({ fontSize: Math.min(999, ts.fontSize + 1) }) }
          if (e.key === 'ArrowDown') { e.preventDefault(); setStyle({ fontSize: Math.max(1, ts.fontSize - 1) }) }
        }}
        style={{
          width: 30, textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,0.7)',
          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 4, padding: '2px 2px', outline: 'none', fontFamily: 'inherit',
        }}
        title="Font size (px)"
      />
      <button style={btnStyle()} onClick={() => {
        const cur = ts.fontSize
        const next = FONT_SIZES.find(s => s > cur) ?? Math.min(999, cur + 1)
        setStyle({ fontSize: next })
      }}>+</button>

      {/* Font family */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...btnStyle(showPopup === 'font'), fontSize: 10, padding: '2px 5px', maxWidth: 58, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          onClick={() => setShowPopup(showPopup === 'font' ? null : 'font')}
          title="Font family"
        >{FONT_LIST.find(f => f.value === (ts.fontFamily ?? FONT_LIST[0].value))?.label ?? 'System'}</button>
        {showPopup === 'font' && (
          <div
            onPointerDown={e => { e.preventDefault(); e.stopPropagation() }}
            style={{
              position: 'absolute', top: 32, left: -4, zIndex: 10001,
              background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              display: 'flex', flexDirection: 'column', gap: 1, width: 170, maxHeight: 320, overflowY: 'auto',
            }}
          >
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', padding: '4px 8px 2px', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' }}>System</div>
            {FONT_LIST.filter(f => !f.google).map(f => (
              <button
                key={f.value}
                onClick={() => { setStyle({ fontFamily: f.value }); setShowPopup(null) }}
                style={{
                  ...btnStyle((ts.fontFamily ?? FONT_LIST[0].value) === f.value),
                  fontFamily: f.value, fontSize: 12, padding: '4px 8px',
                  textAlign: 'left', width: '100%', justifyContent: 'flex-start',
                }}
              >{f.label}</button>
            ))}
            <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '4px 0' }} />
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', padding: '2px 8px 2px', fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' }}>Google Fonts</div>
            {FONT_LIST.filter(f => f.google).map(f => (
              <button
                key={f.value}
                onMouseEnter={() => loadGoogleFont(f.label)}
                onClick={() => { loadGoogleFont(f.label); setStyle({ fontFamily: f.value }); setShowPopup(null) }}
                style={{
                  ...btnStyle((ts.fontFamily ?? FONT_LIST[0].value) === f.value),
                  fontFamily: f.value, fontSize: 12, padding: '4px 8px',
                  textAlign: 'left', width: '100%', justifyContent: 'flex-start',
                }}
              >{f.label}</button>
            ))}
          </div>
        )}
      </div>

      <div style={sepStyle} />

      {/* Font weight — popup with common weights */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...btnStyle(showPopup === 'weight'), fontSize: 10, padding: '2px 5px', minWidth: 28 }}
          onClick={() => setShowPopup(showPopup === 'weight' ? null : 'weight')}
          title="Font weight"
        >
          <span style={{ fontWeight: ts.fontWeight ?? (ts.bold ? 700 : 400) }}>W</span>
        </button>
        {showPopup === 'weight' && (
          <div
            onPointerDown={e => { e.preventDefault(); e.stopPropagation() }}
            style={{
              position: 'absolute', top: 32, left: -4, zIndex: 10001,
              background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              display: 'flex', flexDirection: 'column', gap: 1, width: 120,
            }}
          >
            {FONT_WEIGHTS.map(w => (
              <button
                key={w.value}
                onClick={() => { setStyle({ fontWeight: w.value, bold: w.value >= 600 }); setShowPopup(null) }}
                style={{
                  ...btnStyle((ts.fontWeight ?? (ts.bold ? 700 : 400)) === w.value),
                  fontWeight: w.value, fontSize: 11, padding: '3px 8px',
                  textAlign: 'left', width: '100%', justifyContent: 'flex-start',
                }}
              >{w.label}</button>
            ))}
          </div>
        )}
      </div>

      {/* Italic */}
      <button style={{ ...btnStyle(ts.italic), fontStyle: 'italic', fontSize: 13 }} onClick={() => setStyle({ italic: !ts.italic })}>I</button>

      {/* Text transform */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...btnStyle(showPopup === 'transform'), fontSize: 10, padding: '2px 5px' }}
          onClick={() => setShowPopup(showPopup === 'transform' ? null : 'transform')}
          title="Text transform"
        >Aa</button>
        {showPopup === 'transform' && (
          <div
            onPointerDown={e => { e.preventDefault(); e.stopPropagation() }}
            style={{
              position: 'absolute', top: 32, left: -4, zIndex: 10001,
              background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              display: 'flex', flexDirection: 'column', gap: 1, width: 110,
            }}
          >
            {TEXT_TRANSFORMS.map(t => (
              <button
                key={t.value}
                onClick={() => { setStyle({ textTransform: t.value as any }); setShowPopup(null) }}
                style={{
                  ...btnStyle((ts.textTransform ?? 'none') === t.value),
                  fontSize: 11, padding: '3px 8px',
                  textAlign: 'left', width: '100%', justifyContent: 'flex-start',
                }}
              >{t.label}</button>
            ))}
          </div>
        )}
      </div>

      <div style={sepStyle} />

      {/* Horizontal alignment — popup */}
      <div style={{ position: 'relative' }}>
        <button
          style={btnStyle(showPopup === 'hAlign')}
          onClick={() => setShowPopup(showPopup === 'hAlign' ? null : 'hAlign')}
          title="Horizontal align"
        >
          {hAlignIcons[ts.align]}
        </button>
        {showPopup === 'hAlign' && (
          <AlignPopup
            options={[
              { value: 'left', label: 'Left', icon: hAlignIcons.left },
              { value: 'center', label: 'Center', icon: hAlignIcons.center },
              { value: 'right', label: 'Right', icon: hAlignIcons.right },
            ]}
            selected={ts.align}
            onSelect={v => { setStyle({ align: v as any }); setShowPopup(null) }}
            onClose={() => setShowPopup(null)}
          />
        )}
      </div>

      {/* Vertical alignment — popup */}
      <div style={{ position: 'relative' }}>
        <button
          style={btnStyle(showPopup === 'vAlign')}
          onClick={() => setShowPopup(showPopup === 'vAlign' ? null : 'vAlign')}
          title="Vertical align"
        >
          {vAlignIcons[ts.vAlign]}
        </button>
        {showPopup === 'vAlign' && (
          <AlignPopup
            options={[
              { value: 'top', label: 'Top', icon: vAlignIcons.top },
              { value: 'middle', label: 'Middle', icon: vAlignIcons.middle },
              { value: 'bottom', label: 'Bottom', icon: vAlignIcons.bottom },
            ]}
            selected={ts.vAlign}
            onSelect={v => { setStyle({ vAlign: v as any }); setShowPopup(null) }}
            onClose={() => setShowPopup(null)}
          />
        )}
      </div>

      <div style={sepStyle} />

      {/* Line height */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...btnStyle(showPopup === 'lineHeight'), fontSize: 10, padding: '2px 5px' }}
          onClick={() => setShowPopup(showPopup === 'lineHeight' ? null : 'lineHeight')}
          title="Line height"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 2h12M1 7h12M1 12h12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            <path d="M13 4.5L13 9.5M13 4.5l-1.5 1.5M13 4.5l1.5 1.5M13 9.5l-1.5-1.5M13 9.5l1.5-1.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        {showPopup === 'lineHeight' && (
          <div
            onPointerDown={e => { e.preventDefault(); e.stopPropagation() }}
            style={{
              position: 'absolute', top: 32, left: -4, zIndex: 10001,
              background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              display: 'flex', flexDirection: 'column', gap: 1, width: 80,
            }}
          >
            {LINE_HEIGHTS.map(lh => (
              <button
                key={lh}
                onClick={() => { setStyle({ lineHeight: lh }); setShowPopup(null) }}
                style={{
                  ...btnStyle(Math.abs((ts.lineHeight ?? 1.55) - lh) < 0.01),
                  fontSize: 11, padding: '3px 8px',
                  textAlign: 'left', width: '100%', justifyContent: 'flex-start',
                }}
              >{lh.toFixed(1)}</button>
            ))}
          </div>
        )}
      </div>

      {/* Letter spacing */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...btnStyle(showPopup === 'spacing'), fontSize: 10, padding: '2px 5px' }}
          onClick={() => setShowPopup(showPopup === 'spacing' ? null : 'spacing')}
          title="Letter spacing"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 3L7 11M11 3L7 11" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
            <path d="M1 13l2-2M1 13l2 2M13 13l-2-2M13 13l-2 2" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        {showPopup === 'spacing' && (
          <div
            onPointerDown={e => { e.preventDefault(); e.stopPropagation() }}
            style={{
              position: 'absolute', top: 32, left: -4, zIndex: 10001,
              background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 8, padding: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
              display: 'flex', flexDirection: 'column', gap: 1, width: 80,
            }}
          >
            {LETTER_SPACINGS.map(ls => (
              <button
                key={ls}
                onClick={() => { setStyle({ letterSpacing: ls }); setShowPopup(null) }}
                style={{
                  ...btnStyle((ts.letterSpacing ?? 0) === ls),
                  fontSize: 11, padding: '3px 8px',
                  textAlign: 'left', width: '100%', justifyContent: 'flex-start',
                }}
              >{ls === 0 ? '0' : ls > 0 ? `+${ls}` : `${ls}`}</button>
            ))}
          </div>
        )}
      </div>

      <div style={sepStyle} />

      {/* Text color */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...btnStyle(showPopup === 'text'), gap: 4, padding: '2px 6px' }}
          onClick={() => setShowPopup(showPopup === 'text' ? null : 'text')}
          title="Text color"
        >
          <span style={{ fontSize: 13, fontWeight: 700 }}>A</span>
          <div style={{ width: 14, height: 4, borderRadius: 1, background: ts.color, border: '1px solid rgba(255,255,255,0.15)' }} />
        </button>
        {showPopup === 'text' && (
          <ColorSwatchPopup
            colors={PRESET_COLORS}
            selected={ts.color}
            onSelect={c => { setStyle({ color: c }); setShowPopup(null) }}
            onClose={() => setShowPopup(null)}
          />
        )}
      </div>

      {/* Background color + opacity */}
      <div style={{ position: 'relative' }}>
        <button
          style={{ ...btnStyle(showPopup === 'bg'), gap: 4, padding: '2px 6px' }}
          onClick={() => setShowPopup(showPopup === 'bg' ? null : 'bg')}
          title="Background"
        >
          <div style={{
            width: 16, height: 14, borderRadius: 3,
            background: ts.bgOpacity > 0 ? hexToRgba(ts.bgColor, ts.bgOpacity) : 'linear-gradient(135deg, rgba(255,255,255,0.1) 45%, transparent 45%, transparent 55%, rgba(255,255,255,0.1) 55%)',
            border: '1px solid rgba(255,255,255,0.15)',
          }} />
        </button>
        {showPopup === 'bg' && (
          <BgPickerPopup
            bgColor={ts.bgColor}
            bgOpacity={ts.bgOpacity}
            onColorSelect={c => setStyle({ bgColor: c })}
            onOpacityChange={o => setStyle({ bgOpacity: o })}
            onClose={() => setShowPopup(null)}
          />
        )}
      </div>
    </div>,
    document.body
  )
}

