// CardPromptPad.tsx — a Prompt Pad whose words come from cards (Brian
// 2026-11-06). The first Prompt Pad keeps its own word lists; this one
// keeps none. Its words are the backs of the cards fed to it (dock cards
// or a deck against it, or magnet a Card Browser to it: utils/cardBacks).
//
// A Prompt card (card type Prompt) is made for it: each row on its back is
// a group of words, e.g. Lighting: "rim light, golden hour, hard shadows".
// Any other card works too: dock a character and its back (build, outfit,
// colours) becomes words you can put in a prompt, so a prompt is built
// straight from the cast.
//
// Click a word to put it in the prompt tab in use, or drag it into the
// text where it should go. ＋ on a row adds a word to that card's back; ×
// on a word takes it off the card.
//
// The prompt tabs are plain notepads (Brian 2026-11-09): nothing on a card
// changes what a tab holds, and the cards show nothing from the prompt.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { recordHistory } from '../../store/historyStore'
import { ContentScaled, panelContentScale } from '../UI/PanelSurface'
import { RenameInput } from '../UI/RenameInput'
import { cardTitle } from '../../utils/faceStyle'
import { chartCards, chartName, chartRank, detailShown, newDetailId, type CardDetail } from '../../utils/cardTypes'
import { makePromptCard, cardRect } from '../../utils/promptCards'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { cardVisualRect } from '../../hooks/useCardDecks'
import { useCardFeed, tagsOf, setDetailValue } from '../../utils/cardBacks'
import { dockedCards } from '../../utils/filmShots'
import { DIM, EmptyFeed, FAINT, FeedBar, INK, LINE, MiniCard, PANEL_BG, typeLabel } from './cardBackUi'


/** The card column's width: the same however the window is stretched. */
const CARD_COL = 320

/** A new Prompt card on the pad's left, touching it (so docked), or, with
 *  cards docked there already, left of the row they start, so it joins
 *  them; turned over to its back, ready to fill. */
function newPromptCard(nodeId: string): void {
  const node = useFreeNodeStore.getState().nodes[nodeId]
  if (!node || node.pin) return
  const zoom = useCanvasStore.getState().zoom
  const before = useBoardsStore.getState()
  // Where it goes: left of the leftmost docked card level with the pad's
  // top, else against the pad itself.
  let right = node.x, top = node.y
  for (const g of dockedCards(node, before.groups, before.boards)) {
    const v = cardVisualRect(g, before.boards, zoom)?.rect
    if (!v || v.bottom < node.y || v.top > node.y + node.height * 0.25 || v.left >= right) continue
    right = v.left; top = v.top
  }
  const gap = (right === node.x ? 4 : 12) / zoom
  const id = makePromptCard(undefined, undefined, false)
  const r = id && cardRect(id)
  if (!id || !r) return
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(x => x.id === id)!
  bs.setGroupPos(id, g.originY + (top - r.top), g.originX + (right - gap - r.right))
  bs.setSelectedGroup(id)
}

const lc = (w: string) => w.trim().toLowerCase()

/** The prompt with word `w` put on the end, unless it is in there already. */
function withWord(text: string, w: string): string {
  if (text.split(/[,\n]+/).some(x => lc(x) === lc(w))) return text
  const t = text.replace(/[\s,]+$/, '')
  return t ? `${t}, ${w}` : w
}

export const CardPromptPad: React.FC<{ nodeId: string }> = ({ nodeId }) => {
  const node = useFreeNodeStore(s => s.nodes[nodeId])
  const updateFreeNode = useFreeNodeStore(s => s.updateFreeNode)
  const feed = useCardFeed(nodeId)
  const groups = useBoardsStore(s => s.groups)
  const byId = useMemo(() => new Map(groups.map(g => [g.id, g])), [groups])
  const cards = useMemo(() => feed.ids.map(id => byId.get(id)).filter((g): g is ProjectGroup => !!g), [feed.ids, byId])
  // The one card the pad shows: the one picked in its strip, or the one
  // last clicked on the canvas (if it is fed to the pad), else the first.
  const [picked, setPicked] = useState<string | null>(null)
  useEffect(() => useBoardsStore.subscribe((st, was) => {
    if (st.selectedGroupIds === was.selectedGroupIds || st.selectedGroupIds.length !== 1) return
    const g = st.groups.find(x => x.id === st.selectedGroupIds[0])
    setPicked((g?.linkOf && st.groups.some(x => x.id === g.linkOf) ? g.linkOf : g?.id) ?? null)
  }), [])
  const shown = cards.find(g => g.id === picked) ?? cards[0]
  const [adding, setAdding] = useState<string | null>(null)   // detail id
  const [sent, setSent] = useState(0)
  const [naming, setNaming] = useState<string | null>(null)   // card id: a new detail being named
  const [chartMenu, setChartMenu] = useState<string | null>(null)   // card id
  const taRef = useRef<HTMLTextAreaElement>(null)

  const text = node?.text ?? ''
  const setText = (v: string) => updateFreeNode(nodeId, { text: v })

  /** A word clicked on a card: put in the prompt tab in use. */
  const addToPrompt = (w: string) => setText(withWord(text, w))

  // ── Prompt tabs: named prompts kept side by side (Brian 2026-11-06) ──
  const tabs = node?.promptTabs?.length ? node.promptTabs : [{ name: 'Prompt 1', text }]
  const tabAt = Math.min(Math.max(0, node?.promptTab ?? 0), tabs.length - 1)
  const [renaming, setRenaming] = useState<number | null>(null)
  /** The tabs with the one in use holding what is written now. */
  const tabsNow = () => tabs.map((t, i) => i === tabAt ? { ...t, text } : t)
  const saveTabs = (list: { name: string; text: string }[], at: number) => {
    useUndoCoordinator.getState().checkpoint()
    updateFreeNode(nodeId, { promptTabs: list, promptTab: at, text: list[at].text })
  }
  const switchTab = (i: number) => { if (i !== tabAt) saveTabs(tabsNow(), i) }
  const addTab = () => {
    const names = new Set(tabs.map(t => t.name))
    let n = tabs.length + 1
    while (names.has(`Prompt ${n}`)) n++
    const list = [...tabsNow(), { name: `Prompt ${n}`, text: '' }]
    saveTabs(list, list.length - 1)
  }
  const closeTab = (i: number) => {
    const list = tabsNow().filter((_, j) => j !== i)
    if (!list.length) { saveTabs([{ name: 'Prompt 1', text: '' }], 0); return }
    saveTabs(list, i < tabAt ? tabAt - 1 : Math.min(tabAt, list.length - 1))
  }
  const renameTab = (i: number, name: string) => {
    const nm = name.trim()
    setRenaming(null)
    if (!nm || nm === tabs[i].name) return
    saveTabs(tabsNow().map((t, j) => j === i ? { ...t, name: nm } : t), tabAt)
  }

  const typed = (v: string) => setText(v)

  const send = () => {
    const t = text.trim()
    if (!t) return
    recordHistory({ kind: 'prompt', sourceId: nodeId, label: t, prompt: t })
    setSent(n => n + 1)
  }

  /** One word off a card's back. */
  const dropWord = (g: ProjectGroup, detailId: string, w: string) => {
    const d = g.details?.find(x => x.id === detailId)
    if (!d) return
    setDetailValue(g.id, d.id, tagsOf(d.value).filter(x => x !== w).join(', '))
  }
  /** One word onto a card's back. */
  const addWord = (g: ProjectGroup, detailId: string, w: string) => {
    const d = g.details?.find(x => x.id === detailId)
    const words = tagsOf(w)
    if (!d || !words.length) return
    setDetailValue(g.id, d.id, [...tagsOf(d.value), ...words].join(', '))
  }

  /** A new detail on card g's back, called `name`; then its words are asked for. */
  const addDetail = (g: ProjectGroup, name: string) => {
    setNaming(null)
    const nm = name.trim()
    if (!nm) return
    const row: CardDetail = { id: newDetailId(), name: nm, value: '' }
    useUndoCoordinator.getState().checkpoint()
    useBoardsStore.getState().setGroupDetails(g.id, [...(g.details ?? []), row])
    setAdding(row.id)
  }
  /** A detail reading card g's rank on chart card `chartId` (as + chart on the card's back). */
  const addRank = (g: ProjectGroup, chartId: string) => {
    setChartMenu(null)
    const chart = groups.find(c => c.id === chartId)
    if (!chart || (g.details ?? []).some(d => d.link?.rankOf && d.link.card === chartId)) return
    useUndoCoordinator.getState().checkpoint()
    useBoardsStore.getState().setGroupDetails(g.id, [...(g.details ?? []), { id: newDetailId(), name: chartName(chart), value: '', link: { card: chartId, rankOf: g.id } }])
  }
  const charts = chartCards(groups)

  const btn = (tone: 'plain' | 'go' = 'plain'): React.CSSProperties => ({
    height: 26, padding: '0 10px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
    background: tone === 'go' ? 'rgba(95,208,230,0.16)' : 'rgba(255,255,255,0.05)',
    border: `1px solid ${tone === 'go' ? 'rgba(95,208,230,0.5)' : LINE}`, color: INK, whiteSpace: 'nowrap',
  })

  // ── Dragging words and sections about on the card (Brian 2026-11-07) ──
  // A word dragged onto another word goes before or after it, in its row
  // or another; onto a row's empty space, at its end. A section dragged by
  // its title line goes above or below another. Words still drag into the
  // prompt text as before.
  const moving = useRef<{ kind: 'word'; gid: string; detailId: string; w: string } | { kind: 'row'; gid: string; detailId: string } | null>(null)
  const [over, setOver] = useState<{ detailId: string; at: number } | { row: number } | null>(null)
  const moveWord = (g: ProjectGroup, fromId: string, w: string, toId: string, at: number) => {
    const ds = g.details ?? []
    const from = ds.find(d => d.id === fromId), to = ds.find(d => d.id === toId)
    if (!from || !to || from.link || to.link) return
    const src = tagsOf(from.value)
    const i = src.indexOf(w)
    if (i < 0) return
    let dst = fromId === toId ? src : tagsOf(to.value)
    if (fromId === toId) {
      if (at === i || at === i + 1) return
      dst = [...src]; dst.splice(i, 1)
      dst.splice(at > i ? at - 1 : at, 0, w)
    } else {
      if (dst.some(x => lc(x) === lc(w))) at = -1   // already there: just leaves its old row
      dst = [...dst]
      if (at >= 0) dst.splice(at, 0, w)
    }
    const next = ds.map(d => d.id === fromId && fromId !== toId ? { ...d, value: src.filter((_, j) => j !== i).join(', ') }
      : d.id === toId ? { ...d, value: dst.join(', ') } : d)
    useUndoCoordinator.getState().checkpoint()
    useBoardsStore.getState().setGroupDetails(g.id, next)
  }
  const moveRow = (g: ProjectGroup, id: string, at: number) => {
    const ds = [...(g.details ?? [])]
    const i = ds.findIndex(d => d.id === id)
    if (i < 0 || at === i || at === i + 1) return
    const [d] = ds.splice(i, 1)
    ds.splice(at > i ? at - 1 : at, 0, d)
    useUndoCoordinator.getState().checkpoint()
    useBoardsStore.getState().setGroupDetails(g.id, ds)
  }
  const [renamingCard, setRenamingCard] = useState<string | null>(null)
  const renameCard = (g: ProjectGroup, name: string) => {
    setRenamingCard(null)
    const nm = name.trim()
    if (!nm || nm === g.name) return
    useUndoCoordinator.getState().checkpoint()
    useBoardsStore.getState().renameGroup(g.id, nm)
  }
  const endMove = () => { moving.current = null; setOver(null) }
  /** Drop handlers for a word target: the row `detailId`, slot `at` (or the slot by the pointer, on a chip). */
  const wordTarget = (g: ProjectGroup, detailId: string, slot: (e: React.DragEvent) => number) => ({
    onDragOver: (e: React.DragEvent) => {
      const m = moving.current
      if (m?.kind !== 'word' || m.gid !== g.id) return
      e.preventDefault(); e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
      const at = slot(e)
      setOver(o => (o && 'detailId' in o && o.detailId === detailId && o.at === at) ? o : { detailId, at })
    },
    onDrop: (e: React.DragEvent) => {
      const m = moving.current
      if (m?.kind !== 'word' || m.gid !== g.id) return
      e.preventDefault(); e.stopPropagation()
      moveWord(g, m.detailId, m.w, detailId, slot(e))
      endMove()
    },
  })

  const smallBtn: React.CSSProperties = {
    height: 24, padding: '0 9px', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit', fontSize: 11.5, fontWeight: 700,
    background: 'rgba(255,255,255,0.04)', border: `1px dashed rgba(255,255,255,0.22)`, color: DIM,
  }

  const chip = (g: ProjectGroup, detailId: string, w: string, canEdit: boolean, i: number) => {
    const mark = over && 'detailId' in over && over.detailId === detailId && canEdit ? (over.at === i ? 'before' : over.at === i + 1 ? 'after' : null) : null
    const drop = canEdit ? wordTarget(g, detailId, e => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      return e.clientX < r.left + r.width / 2 ? i : i + 1
    }) : {}
    return (
      <span
        key={w}
        draggable
        onDragStart={e => {
          e.stopPropagation()
          e.dataTransfer.setData('text/plain', w)
          e.dataTransfer.effectAllowed = 'copyMove'
          moving.current = canEdit ? { kind: 'word', gid: g.id, detailId, w } : null
        }}
        onDragEnd={endMove}
        {...drop}
        onClick={() => addToPrompt(w)}
        title="Click to add to the prompt, or drag it into the text"
        className="cpp-chip"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', boxSizing: 'border-box',
          minHeight: 24, padding: '3px 9px', borderRadius: 12, cursor: 'pointer', userSelect: 'none', lineHeight: 1.3,
          background: 'rgba(255,255,255,0.055)',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: mark === 'before' ? '-3px 0 0 0 #fff' : mark === 'after' ? '3px 0 0 0 #fff' : 'none',
          color: 'rgba(232,238,255,0.8)', fontSize: 12.5,
          transition: 'background 0.12s, border-color 0.12s, box-shadow 0.12s',
        }}
      >
        <span style={{ overflowWrap: 'anywhere' }}>{w}</span>
        {canEdit && (
          <span
            className="cpp-x"
            onClick={e => { e.stopPropagation(); dropWord(g, detailId, w) }}
            title="Take this word off the card"
            style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginRight: -3 }}
          >×</span>
        )}
      </span>
    )
  }

  const cardPanel = (g: ProjectGroup) => {
    const rows = (g.details ?? []).map(d => ({ d, words: tagsOf(detailShown(groups, d).text) }))
    return (
      <div key={g.id} style={{
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', borderRadius: 10, overflow: 'hidden',
        background: 'rgba(255,255,255,0.025)', border: `1px solid ${g.color}66`,
        boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
      }}>
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', userSelect: 'none', flexShrink: 0,
            background: `linear-gradient(90deg, ${g.color}cc, ${g.color}55)`,
          }}
        >
          {renamingCard === g.id ? (
            <RenameInput
              autoFocus
              defaultValue={g.name}
              onPointerDown={e => e.stopPropagation()}
              onKeyDown={e => {
                if (e.key === 'Enter') renameCard(g, (e.target as HTMLInputElement).value)
                if (e.key === 'Escape') setRenamingCard(null)
              }}
              onBlur={e => renameCard(g, e.target.value)}
              style={{ flex: 1, minWidth: 0, height: 24, fontSize: 13 }}
            />
          ) : (
            <span
              onDoubleClick={() => setRenamingCard(g.id)}
              title="Double-click to rename the card"
              style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text' }}
            >
              {cardTitle(groups, g) || 'Untitled'}
            </span>
          )}
          <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase', color: 'rgba(255,255,255,0.8)' }}>{typeLabel(g)}</span>
        </div>
        {(
          <div style={{ padding: '12px 10px 10px', flex: 1, minHeight: 0, overflowY: 'auto' }} data-wheel-own="">
            {rows.length === 0 && <div style={{ fontSize: 12, color: FAINT, padding: '4px 0' }}>Nothing on its back yet: + detail adds a row.</div>}
            {rows.map(({ d, words }, ri) => (
              <div key={d.id} style={{
                marginTop: 6, position: 'relative',
                boxShadow: over && 'row' in over ? (over.row === ri ? '0 -3px 0 -1px #fff' : over.row === ri + 1 && ri === rows.length - 1 ? '0 3px 0 -1px #fff' : 'none') : 'none',
              }}>
                <div
                  className="cpp-sec"
                  draggable
                  onDragStart={e => {
                    e.stopPropagation()
                    e.dataTransfer.setData('application/x-cpp-row', d.id)
                    e.dataTransfer.effectAllowed = 'move'
                    moving.current = { kind: 'row', gid: g.id, detailId: d.id }
                  }}
                  onDragEnd={endMove}
                  onDragOver={e => {
                    const m = moving.current
                    if (m?.kind !== 'row' || m.gid !== g.id) return
                    e.preventDefault(); e.stopPropagation()
                    const r = e.currentTarget.getBoundingClientRect()
                    const at = e.clientY < r.top + r.height / 2 ? ri : ri + 1
                    setOver(o => (o && 'row' in o && o.row === at) ? o : { row: at })
                  }}
                  onDrop={e => {
                    const m = moving.current
                    if (m?.kind !== 'row' || m.gid !== g.id) return
                    e.preventDefault(); e.stopPropagation()
                    const r = e.currentTarget.getBoundingClientRect()
                    moveRow(g, m.detailId, e.clientY < r.top + r.height / 2 ? ri : ri + 1)
                    endMove()
                  }}
                  title="Drag the title line to move this section up or down"
                  style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, cursor: 'grab', position: 'relative' }}
                >
                  <svg className="cpp-grip" width="8" height="13" viewBox="0 0 8 13" style={{ position: 'absolute', left: -10, top: '50%', transform: 'translateY(-50%)' }}>
                    {[1.8, 6.2].flatMap(cx => [2, 6.5, 11].map(cy => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={1.5} fill="rgba(232,238,255,0.9)" />))}
                  </svg>
                  <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', color: DIM, paddingLeft: 3 }}>{d.name || '—'}</span>
                  <div style={{ flex: 1, height: 1, background: LINE }} />
                  {!d.link && (
                    <span
                      onClick={() => setAdding(d.id)}
                      title={`Add a word to ${d.name || 'this row'} on the card`}
                      style={{ fontSize: 13, color: DIM, cursor: 'pointer', padding: '0 2px' }}
                    >＋</span>
                  )}
                </div>
                <div
                  style={{ display: 'flex', flexWrap: 'wrap', gap: 4, minHeight: 24 }}
                  {...(!d.link ? wordTarget(g, d.id, () => words.length) : {})}
                >
                  {words.map((w, i) => chip(g, d.id, w, !d.link, i))}
                  {words.length === 0 && adding !== d.id && <span style={{ fontSize: 11.5, color: FAINT }}>empty</span>}
                  {adding === d.id && (
                    <RenameInput
                      autoFocus
                      placeholder="new words, comma separated"
                      onPointerDown={e => e.stopPropagation()}
                      onKeyDown={e => {
                        if (e.key === 'Enter') { addWord(g, d.id, (e.target as HTMLInputElement).value); setAdding(null) }
                        if (e.key === 'Escape') setAdding(null)
                      }}
                      onBlur={e => { addWord(g, d.id, e.target.value); setAdding(null) }}
                      style={{ height: 24, width: 140, fontSize: 12 }}
                    />
                  )}
                </div>
              </div>
            ))}
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 10, position: 'relative' }}>
              {naming === g.id ? (
                <RenameInput
                  autoFocus
                  placeholder="detail name, e.g. Lighting"
                  onPointerDown={e => e.stopPropagation()}
                  onKeyDown={e => {
                    if (e.key === 'Enter') addDetail(g, (e.target as HTMLInputElement).value)
                    if (e.key === 'Escape') setNaming(null)
                  }}
                  onBlur={e => addDetail(g, e.target.value)}
                  style={{ height: 24, width: 160, fontSize: 12 }}
                />
              ) : (
                <button className="cpp-add" onClick={() => setNaming(g.id)} title="Add a detail to this card's back" style={smallBtn}>+ detail</button>
              )}
              {charts.length > 0 && (
                <button className="cpp-add" onClick={() => setChartMenu(m => m === g.id ? null : g.id)} title="Add its rank on a chart" style={smallBtn}>+ chart</button>
              )}
              {chartMenu === g.id && (
                <div style={{
                  position: 'absolute', left: 0, top: 30, zIndex: 20, minWidth: 200, padding: 4, borderRadius: 9,
                  background: '#1b1e2c', border: `1px solid ${LINE}`, boxShadow: '0 10px 30px rgba(0,0,0,0.55)',
                }}>
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', color: DIM, padding: '4px 10px' }}>Rank on chart</div>
                  {charts.map(c => {
                    const r = chartRank(c, g.id)
                    const have = (g.details ?? []).some(d => d.link?.rankOf && d.link.card === c.id)
                    return (
                      <div key={c.id} className="cpp-item" onClick={() => addRank(g, c.id)}
                        style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, color: have ? DIM : INK }}>
                        <span style={{ width: 9, height: 9, borderRadius: 2, background: c.color, flexShrink: 0 }} />
                        <span style={{ flex: 1 }}>{chartName(c)}</span>
                        <span style={{ fontSize: 11, color: FAINT }}>{have ? 'on it' : r ? `rank ${r.rank}` : 'not on it'}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  if (!node) return null
  return (
    <div
      onPointerDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      data-wheel-own=""
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: PANEL_BG }}
    >
      <style>{`.cpp-chip .cpp-x { opacity: 0; transition: opacity 0.1s } .cpp-chip:hover .cpp-x { opacity: 1 } .cpp-item:hover { background: rgba(95,208,230,0.14) } .cpp-add:hover { color: #fff; border-color: rgba(95,208,230,0.6) } .cpp-sec .cpp-grip { opacity: 0.35; transition: opacity 0.1s } .cpp-sec:hover .cpp-grip { opacity: 1 } .cpp-tab .cpp-x { opacity: 0.55 } .cpp-tab:hover .cpp-x { opacity: 1 } .cpp-tab .cpp-x:hover { background: rgba(255,255,255,0.12) }`}</style>
      <ContentScaled factor={panelContentScale(node)}>
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif', color: INK }}>
          <FeedBar
            feed={feed}
            cards={cards}
            right={<>
              {sent > 0 && <span style={{ fontSize: 11, color: DIM, marginRight: 6 }}>sent {sent}× · see History</span>}
              <button
                style={btn('go')}
                onClick={() => newPromptCard(nodeId)}
                disabled={!!node.pin}
                title="A blank Prompt card, docked on this pad's left. The ready-made ones are under the top bar's Prompt card button."
              >＋ Prompt card</button>
            </>}
          />
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            {/* ── One card at a time, at a steady width: the window's extra
                room all goes to the prompt (Brian 2026-11-06). ── */}
            <div style={{ width: CARD_COL, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: 10, borderRight: `1px solid ${LINE}`, minHeight: 0 }}>
              {cards.length === 0 ? <EmptyFeed what="Their backs become words for the prompt. ＋ Prompt card makes one to fill." /> : <>
                {cards.length > 1 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, flexShrink: 0 }}>
                    {cards.map(g => (
                      <div key={g.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, width: 46 }}>
                        <MiniCard g={g} w={30} lit={g.id === shown?.id} onClick={() => setPicked(g.id)} />
                        <span style={{ fontSize: 9, color: g.id === shown?.id ? INK : FAINT, width: '100%', textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cardTitle(groups, g) || 'Untitled'}</span>
                      </div>
                    ))}
                  </div>
                )}
                {shown && cardPanel(shown)}
              </>}
            </div>
            {/* ── The prompt: as big as the window lets it be ── */}
            <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: 10, background: 'rgba(95,208,230,0.03)' }}>
              {/* Tabs along the top of the writing: named prompts. Double-click to rename. */}
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, marginBottom: -9, flexShrink: 0, minWidth: 0, position: 'relative', zIndex: 1 }}>
                {tabs.map((t, i) => {
                  const on = i === tabAt
                  return (
                    <div
                      key={i}
                      onClick={() => switchTab(i)}
                      onDoubleClick={() => setRenaming(i)}
                      title={`${t.name} · double-click to rename`}
                      className="cpp-tab"
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, maxWidth: 180, flexShrink: 1,
                        height: 28, padding: '0 6px 0 11px', boxSizing: 'border-box', cursor: 'pointer', userSelect: 'none',
                        borderRadius: '8px 8px 0 0', fontSize: 12.5, fontWeight: on ? 600 : 500,
                        color: on ? INK : DIM,
                        background: on ? '#11131b' : 'rgba(255,255,255,0.04)',
                        border: `1px solid ${on ? 'rgba(95,208,230,0.3)' : LINE}`,
                        borderBottomColor: on ? '#11131b' : 'rgba(95,208,230,0.3)',
                      }}
                    >
                      {renaming === i ? (
                        <RenameInput
                          autoFocus
                          defaultValue={t.name}
                          onPointerDown={e => e.stopPropagation()}
                          onKeyDown={e => {
                            if (e.key === 'Enter') renameTab(i, (e.target as HTMLInputElement).value)
                            if (e.key === 'Escape') setRenaming(null)
                          }}
                          onBlur={e => renameTab(i, e.target.value)}
                          style={{ height: 22, width: 110, fontSize: 12 }}
                        />
                      ) : (
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                      )}
                      <span
                        className="cpp-x"
                        onClick={e => { e.stopPropagation(); closeTab(i) }}
                        title="Close this prompt (Ctrl+Z brings it back)"
                        style={{ fontSize: 13, lineHeight: 1, color: DIM, padding: '0 3px', borderRadius: 4 }}
                      >×</span>
                    </div>
                  )
                })}
                <div
                  onClick={addTab}
                  title="A new prompt"
                  className="cpp-item"
                  style={{ height: 26, width: 26, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 7, cursor: 'pointer', fontSize: 15, color: DIM, marginBottom: 2 }}
                >＋</div>
              </div>
              <textarea
                ref={taRef}
                value={text}
                onChange={e => typed(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() }
                  e.stopPropagation()
                }}
                placeholder="Click the words on the card, or drag them in here. Stretch the window to write longer."
                style={{
                  flex: 1, minHeight: 0, resize: 'none', boxSizing: 'border-box',
                  background: '#11131b', color: INK, border: `1px solid rgba(95,208,230,0.3)`, borderRadius: 8,
                  padding: '10px 12px', fontSize: 14, lineHeight: 1.55, fontFamily: 'inherit', outline: 'none',
                }}
              />
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <span style={{ flex: 1, alignSelf: 'center', fontSize: 11, color: FAINT }}>Ctrl+Enter sends · recorded in History</span>
                <button onClick={() => setText('')} title="Clear the prompt" style={btn()}>Clear</button>
                <button
                  onClick={send}
                  disabled={!text.trim()}
                  title="Send (Ctrl+Enter): recorded in History"
                  style={{ ...btn('go'), padding: '0 18px', opacity: text.trim() ? 1 : 0.45, cursor: text.trim() ? 'pointer' : 'default' }}
                >Send ⏎</button>
              </div>
            </div>
          </div>
        </div>
      </ContentScaled>
    </div>
  )
}
