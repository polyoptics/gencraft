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
// Click a word to put it in the prompt, click it again (lit) to take it out,
// or drag it into the text where it should go. ＋ on a row adds a word to
// that card's back; × on a word takes it off the card.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useBoardsStore, type ProjectGroup } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { recordHistory } from '../../store/historyStore'
import { ContentScaled, panelContentScale } from '../UI/PanelSurface'
import { RenameInput } from '../UI/RenameInput'
import { cardTitle } from '../../utils/faceStyle'
import { detailShown, newDetailId } from '../../utils/cardTypes'
import { createCardOrBoardAt } from '../../utils/canvasCreate'
import { cardVisualRect } from '../../hooks/useCardDecks'
import { useCardFeed, tagsOf, setDetailValue } from '../../utils/cardBacks'
import { dockedCards } from '../../utils/filmShots'
import { DIM, EmptyFeed, FAINT, FeedBar, INK, LINE, MiniCard, PANEL_BG, typeLabel } from './cardBackUi'


/** The card column's width: the same however the window is stretched. */
const CARD_COL = 320

/** The prompt's words, as the pad compares them with a card's. */
const promptWords = (text: string) => new Set(text.split(/[,\n]+/).map(s => s.trim().toLowerCase()).filter(Boolean))

/** Ready-made Prompt cards (Brian 2026-11-06, his words), each row a group
 *  of phrases, comma separated. "Old Prompt Pad words" carries over the
 *  first Prompt Pad's starting words. */
const PRESETS: { name: string; rows: [string, string][] }[] = [
  { name: 'Audio', rows: [
    ['Era', '70s'], ['Genre', 'sci-fi'], ['Sound', 'synthesizer, chords, arpeggiated'],
    ['Mood', 'melancholy'], ['Texture', 'VHS'],
  ] },
  { name: '3D generation', rows: [
    ['Pose', 'pose the character, T-pose, arms to the side, arms straight out, legs spread, feet flat, looking forward, relaxed, neutral pose'],
    ['For 3D', 'even lighting, texture atlas, seamless'],
  ] },
  { name: 'My style', rows: [
    ['Finish', 'rough hand-inked retro-futurist illustration finish, bold dark contours, scratchy linework, crosshatched shadows, painterly/cel-shaded color blocks, textured print-like surface'],
    ['Palette', 'muted pale blues, ivories and charcoals, restrained rust accents'],
    ['Avoid', 'no photoreal skin pores, no added products, no gear, no spacecraft, no weapons, no typography, no extra subjects'],
  ] },
  { name: 'Old Prompt Pad words', rows: [
    ['Framing', 'isometric view, orthographic view, front, back, left, right, arms out to the side, 3/4 view'],
    ['Grids', '2x2 grid, 3x3 grid, where each cell contains, sprite sheet'],
    ['Isolation', 'clean black background, clean white background, transparent background, no shadow'],
    ['Style matching', 'in the same style as the reference images, flat vector, painterly, photoreal, blueprint'],
  ] },
]

/** A new Prompt card on the pad's left, touching it (so docked), or, with
 *  cards docked there already, left of the row they start, so it joins
 *  them; turned over to its back, ready to fill. */
function newPromptCard(nodeId: string, preset?: (typeof PRESETS)[number]): void {
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
  const boardId = createCardOrBoardAt({ cx: right - 4000 / zoom, cy: top })
  const bs = useBoardsStore.getState()
  const g = bs.groups.find(x => x.boardIds.includes(boardId))
  if (!g) return
  bs.renameGroup(g.id, preset?.name ?? 'Prompt')
  bs.setGroupCardType(g.id, 'prompt')
  if (preset) bs.setGroupDetails(g.id, preset.rows.map(([name, value]) => ({ id: newDetailId(), name, value })))
  bs.setGroupFlipped(g.id, true)
  const now = useBoardsStore.getState()
  const v = cardVisualRect(now.groups.find(x => x.id === g.id)!, now.boards, zoom)
  if (v) now.setGroupPos(g.id, g.originY + (top - v.rect.top), g.originX + (right - gap - v.rect.right))
  now.setSelectedGroup(g.id)
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
  const [menu, setMenu] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const text = node?.text ?? ''
  const setText = (v: string) => updateFreeNode(nodeId, { text: v })
  const inPrompt = useMemo(() => promptWords(text), [text])

  const toggleWord = (w: string) => {
    const key = w.trim().toLowerCase()
    if (inPrompt.has(key)) {
      // Out again: the word and the comma that joined it.
      const parts = text.split(',').map(s => s.trim()).filter(s => s && s.toLowerCase() !== key)
      setText(parts.join(', '))
    } else {
      const t = text.trim().replace(/,$/, '')
      setText(t ? `${t}, ${w}` : w)
    }
  }

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

  const btn = (tone: 'plain' | 'go' = 'plain'): React.CSSProperties => ({
    height: 26, padding: '0 10px', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
    background: tone === 'go' ? 'rgba(95,208,230,0.16)' : 'rgba(255,255,255,0.05)',
    border: `1px solid ${tone === 'go' ? 'rgba(95,208,230,0.5)' : LINE}`, color: INK, whiteSpace: 'nowrap',
  })

  const chip = (g: ProjectGroup, detailId: string, w: string, canEdit: boolean) => {
    const on = inPrompt.has(w.toLowerCase())
    return (
      <span
        key={w}
        draggable
        onDragStart={e => { e.stopPropagation(); e.dataTransfer.setData('text/plain', w); e.dataTransfer.effectAllowed = 'copy' }}
        onClick={() => toggleWord(w)}
        title={on ? 'In the prompt: click to take it out' : 'Click to add to the prompt, or drag it into the text'}
        className="cpp-chip"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%', boxSizing: 'border-box',
          minHeight: 24, padding: '3px 9px', borderRadius: 12, cursor: 'pointer', userSelect: 'none', lineHeight: 1.3,
          background: on ? `${g.color}55` : 'rgba(255,255,255,0.055)',
          border: `1px solid ${on ? g.color : 'rgba(255,255,255,0.1)'}`,
          boxShadow: on ? `0 0 8px ${g.color}66` : 'none',
          color: on ? '#fff' : 'rgba(232,238,255,0.8)', fontSize: 12.5,
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
    const lit = rows.reduce((n, r) => n + r.words.filter(w => inPrompt.has(w.toLowerCase())).length, 0)
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
          <span style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 700, color: '#fff', textShadow: '0 1px 2px rgba(0,0,0,0.4)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {cardTitle(groups, g) || 'Untitled'}
          </span>
          {lit > 0 && <span style={{ fontSize: 10.5, color: '#fff', background: 'rgba(0,0,0,0.3)', borderRadius: 8, padding: '0 6px' }} title="Words from this card in the prompt">{lit} in</span>}
          <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: 0.7, textTransform: 'uppercase', color: 'rgba(255,255,255,0.8)' }}>{typeLabel(g)}</span>
        </div>
        {(
          <div style={{ padding: '4px 10px 10px', flex: 1, minHeight: 0, overflowY: 'auto' }} data-wheel-own="">
            {rows.length === 0 && <div style={{ fontSize: 12, color: FAINT, padding: '4px 0' }}>Nothing on its back yet. Turn the card over and add rows.</div>}
            {rows.map(({ d, words }) => (
              <div key={d.id} style={{ marginTop: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', color: DIM }}>{d.name || '—'}</span>
                  <div style={{ flex: 1, height: 1, background: LINE }} />
                  {!d.link && (
                    <span
                      onClick={() => setAdding(d.id)}
                      title={`Add a word to ${d.name || 'this row'} on the card`}
                      style={{ fontSize: 13, color: DIM, cursor: 'pointer', padding: '0 2px' }}
                    >＋</span>
                  )}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {words.map(w => chip(g, d.id, w, !d.link))}
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
      <style>{`.cpp-chip .cpp-x { opacity: 0; transition: opacity 0.1s } .cpp-chip:hover .cpp-x { opacity: 1 } .cpp-item:hover { background: rgba(95,208,230,0.14) }`}</style>
      <ContentScaled factor={panelContentScale(node)}>
        <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif', color: INK }}>
          <FeedBar
            feed={feed}
            cards={cards}
            right={<>
              {sent > 0 && <span style={{ fontSize: 11, color: DIM, marginRight: 6 }}>sent {sent}× · see History</span>}
              <div style={{ position: 'relative' }}>
                <button
                  style={{ ...btn('go'), background: menu ? 'rgba(95,208,230,0.3)' : btn('go').background }}
                  onClick={() => setMenu(m => !m)}
                  disabled={!!node.pin}
                  title="A new Prompt card, docked on this pad's left: blank, or one of the ready-made ones"
                >＋ Prompt card ▾</button>
                {menu && (
                  <div style={{
                    position: 'absolute', right: 0, top: 30, zIndex: 20, minWidth: 210, padding: 4, borderRadius: 9,
                    background: '#1b1e2c', border: `1px solid ${LINE}`, boxShadow: '0 10px 30px rgba(0,0,0,0.55)',
                  }}>
                    {[{ name: 'Blank', rows: [] as [string, string][] }, ...PRESETS].map(pr => (
                      <div
                        key={pr.name}
                        onClick={() => { setMenu(false); newPromptCard(nodeId, pr.name === 'Blank' ? undefined : pr) }}
                        className="cpp-item"
                        style={{ padding: '6px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5, color: INK }}
                      >
                        {pr.name}
                        {pr.rows.length > 0 && <div style={{ fontSize: 10.5, color: FAINT, marginTop: 1 }}>{pr.rows.map(r => r[0]).join(' · ')}</div>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
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
              <textarea
                ref={taRef}
                value={text}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send() }
                  e.stopPropagation()
                }}
                placeholder="Click the words on the card, or drag them in here. Stretch the window to write longer."
                style={{
                  flex: 1, minHeight: 0, resize: 'none', boxSizing: 'border-box',
                  background: 'rgba(0,0,0,0.3)', color: INK, border: `1px solid rgba(95,208,230,0.3)`, borderRadius: 8,
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
