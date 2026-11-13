import React, { useEffect, useRef, useState } from 'react'
import type { ProjectGroup } from '../../store/boardsStore'
import { useFreeNodeStore, type FreeNodeData } from '../../store/freeNodeStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { useResolvedMedia } from '../../utils/useResolvedMedia'
import type { DockedClip } from '../../utils/filmShots'
import { CanvasMirror } from '../UI/CanvasMirror'
import { EFFECTS, effectParams, knownKind, type ParamDef } from '../../utils/fx/effects'
import { runChain, type ChainItem } from '../../utils/fx/chain'
import { useAuxStore } from '../../utils/fx/aiEffects'
import { MOTION_SIDE, motionAttach, motionDrawAll, motionDrop, motionPlay, motionSeek, useClipMotion } from '../../utils/fx/clipMotion'
import { makeClip } from '../../utils/fx/clipRun'
import { saveCanvasImage } from '../../utils/saveImage'
import { diskFileUrl } from '../../utils/diskUrl'
import { cardFaceSize, createMediaCard } from '../../utils/cardGrid'
import { markNew } from '../../utils/newCards'
import { setStyleItems, styleEffects, styleOf, tweakedItems, type StyleTweaks } from '../../utils/styleCard'

/** The LOOK MIXER (Brian 2026-11-13: "a general mix-all tool, centered
 *  around using the looks, modifying the settings, and applying them across
 *  shots"). Shown in the Film Look node whenever what is docked to it is not
 *  the film's own shots: any deck of pictures, videos and GIFs, plus Style
 *  cards (utils/styleCard) for its looks.
 *
 *  Each shot wears a look (the first Style card until another is given to
 *  it) and can change any of that look's settings for itself; a change made
 *  with several shots selected goes to all of them. "Save to the Style card"
 *  makes the shot's settings the look's own. Shots play through their look
 *  (utils/fx/clipMotion: drawn ahead of the playhead and kept), one after
 *  another. Bake makes the finished shots, at full size, as a new deck below
 *  the mixer.
 *
 *  What each shot wears is kept on the node (FreeNodeData.lookMix), by the
 *  shot's key; the looks themselves live on their Style cards.
 *
 *  Laid out at the mixer page's own size and scaled as one, like the film's
 *  mixer, so nothing in it reflows as the node is zoomed or resized. */

const W = 1240, H = 838
const ASIDE = 340
/** How long a still holds when the deck plays through. */
const STILL_HOLD_S = 2
/** A bake renders at up to this long edge (a strip Run's own size). */
const BAKE_SIDE = 8192

const C = {
  bg: '#0f1113', panel: '#171a1d', panel2: '#1f2327', line: '#2a2f34', text: '#d8dde2', dim: '#8a939b', accent: '#e0703a', warn: '#e8b44a', sel: '#8fd3ff',
}

type Source = Extract<ChainItem, { kind: 'source' }>
type Shots = NonNullable<FreeNodeData['lookMix']>['shots']

const moves = (c: DockedClip) => c.kind === 'video' || !!c.gif
const keyOf = (nodeId: string, c: DockedClip) => `mix:${nodeId}:${c.key}`

/** A shot as the first picture of a chain. */
function sourceOf(c: DockedClip): Source {
  const still = c.kind === 'image' ? c.url : c.poster ?? ''
  return {
    id: `shot:${c.key}`, kind: 'source', url: still, label: c.label,
    ...(moves(c) ? { video: c.url } : {}),
    ...(c.kind === 'video' ? { clipIn: c.in || undefined, clipOut: Number.isFinite(c.out) ? c.out : undefined } : {}),
    ...(c.gif ? { gif: true } : {}),
  }
}

const btn: React.CSSProperties = {
  height: 26, padding: '0 10px', borderRadius: 4, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13,
  color: C.text, background: C.panel2, border: `1px solid ${C.line}`, display: 'inline-flex', alignItems: 'center', gap: 6,
}
const lit = (on: boolean): React.CSSProperties => ({ ...btn, ...(on ? { background: '#2e4878', border: '1px solid #8cbeff', color: '#cfe2ff' } : {}) })

export function LookMixer({ nodeId, clips, styles, fit, width }: {
  nodeId: string; clips: DockedClip[]; styles: ProjectGroup[]; fit: number; width: number
}) {
  const shots: Shots = useFreeNodeStore(s => s.nodes[nodeId]?.lookMix?.shots) ?? EMPTY
  const [index, setIndex] = useState(0)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [playing, setPlaying] = useState(false)
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null)
  const [bake, setBake] = useState<{ text: string; stop: boolean } | null>(null)
  const bakeStop = useRef(false)
  const i = Math.min(index, Math.max(0, clips.length - 1))
  const clip = clips[i]
  const selected = sel.size ? sel : new Set(clip ? [clip.key] : [])

  // ── Which look a shot wears, and the chain it plays ──
  const styleFor = (c: DockedClip): ProjectGroup | null => {
    const want = shots[c.key]?.style
    return styles.find(g => g.id === want) ?? styles[0] ?? null
  }
  const itemsFor = (c: DockedClip): ChainItem[] => {
    const g = styleFor(c)
    const look = styleOf(g ?? undefined)
    return [sourceOf(c), ...(look ? tweakedItems(look.items, shots[c.key]?.tweaks) : [])]
  }
  const current = clip ? styleFor(clip) : null
  const currentItems = clip ? itemsFor(clip) : null
  const itemsSig = currentItems ? JSON.stringify(currentItems) : ''

  // ── The picture: a moving shot through the motion engine, a still once ──
  const curKey = clip ? keyOf(nodeId, clip) : ''
  const curRef = useRef(curKey)
  curRef.current = curKey
  useEffect(() => {
    if (!clip || !currentItems) { setCanvas(null); return }
    if (moves(clip)) {
      motionAttach(curKey, currentItems, c => { if (curRef.current === curKey) setCanvas(c) }, { showFirst: true })
      return
    }
    // A still: rendered once per change, and again as a drawing tool's
    // result lands.
    let dead = false
    const draw = () => void runChain(currentItems, MOTION_SIDE, false, { live: true }).then(r => {
      if (!dead && r.outputs[0]) setCanvas(r.outputs[0].canvas)
    })
    draw()
    const off = useAuxStore.subscribe((s, p) => { if (s.version !== p.version) draw() })
    return () => { dead = true; off() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curKey, itemsSig])

  // Every other shot that has been played keeps its frames, following its
  // look as it changes; a shot no longer docked lets them go.
  const engines = useClipMotion(s => s.byKey)
  useEffect(() => {
    const docked = new Map(clips.map(c => [keyOf(nodeId, c), c]))
    for (const k of Object.keys(engines)) {
      if (!k.startsWith(`mix:${nodeId}:`) || k === curKey) continue
      const c = docked.get(k)
      if (!c) motionDrop(k)
      else motionAttach(k, itemsFor(c))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips, shots, styles])
  useEffect(() => () => {
    for (const k of Object.keys(useClipMotion.getState().byKey)) if (k.startsWith(`mix:${nodeId}:`)) motionDrop(k)
  }, [nodeId])

  // ── Playing through the deck: a shot plays to its end, then the next ──
  const m = useClipMotion(s => (curKey ? s.byKey[curKey] : undefined))
  const goTo = (k: number, keepSel = false) => {
    const prev = clip ? keyOf(nodeId, clip) : ''
    if (prev) motionPlay(prev, false)
    setIndex(k)
    if (!keepSel) setSel(new Set())
  }
  useEffect(() => {
    if (!clip) return
    if (!moves(clip)) {
      if (!playing) return
      const t = window.setTimeout(() => { if (i + 1 < clips.length) goTo(i + 1, true); else setPlaying(false) }, STILL_HOLD_S * 1000)
      return () => window.clearTimeout(t)
    }
    motionPlay(curKey, playing)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curKey, playing])
  const lastFrame = useRef<number | null>(null)
  useEffect(() => {
    if (!m || !playing || !clip || !moves(clip)) { lastFrame.current = m?.frame ?? null; return }
    // Wrapped round from its last frame to its first: on to the next shot.
    if (lastFrame.current === m.end - 1 && m.frame === m.first && m.end - m.first > 1) {
      if (i + 1 < clips.length) goTo(i + 1, true)
      else { setPlaying(false); motionPlay(curKey, false) }
    }
    lastFrame.current = m.frame
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [m?.frame])

  // ── Writing what the shots wear ──
  const write = (fn: (s: Shots) => Shots) => {
    const node = useFreeNodeStore.getState().nodes[nodeId]
    if (!node) return
    useFreeNodeStore.getState().updateFreeNode(nodeId, { lookMix: { shots: fn({ ...(node.lookMix?.shots ?? {}) }) } })
  }
  const checkpoint = () => useUndoCoordinator.getState().checkpoint()
  const giveLook = (styleId: string) => {
    checkpoint()
    write(s => { for (const k of selected) s[k] = { ...s[k], style: styleId }; return s })
  }
  const setTweak = (effectId: string, change: { key: string; v: number } | { text: string } | null) => write(s => {
    for (const k of selected) {
      const tw: StyleTweaks = { ...(s[k]?.tweaks ?? {}) }
      const t = { ...tw[effectId] }
      if (change === null) delete tw[effectId]
      else if ('text' in change) tw[effectId] = { ...t, text: change.text }
      else tw[effectId] = { ...t, params: { ...t.params, [change.key]: change.v } }
      s[k] = { ...s[k], tweaks: tw }
    }
    return s
  })
  const resetParam = (effectId: string, key: string) => {
    checkpoint()
    write(s => {
      for (const k of selected) {
        const tw = { ...(s[k]?.tweaks ?? {}) }
        const p = { ...tw[effectId]?.params }
        delete p[key]
        tw[effectId] = { ...tw[effectId], params: p }
        s[k] = { ...s[k], tweaks: tw }
      }
      return s
    })
  }
  const clearShot = () => {
    checkpoint()
    write(s => { for (const k of selected) s[k] = { ...s[k], tweaks: {} }; return s })
  }
  const saveToStyle = () => {
    if (!clip || !current) return
    const look = styleOf(current)
    if (!look) return
    checkpoint()
    const mine = shots[clip.key]?.tweaks
    setStyleItems(current.id, tweakedItems(look.items, mine))
    // These are the look's own now: the shot no longer differs from it.
    write(s => { s[clip.key] = { ...s[clip.key], tweaks: {} }; return s })
  }

  // ── Selecting shots ──
  const pick = (k: number, e: React.MouseEvent) => {
    const c = clips[k]
    if (e.shiftKey && clip) {
      const [a, b] = [Math.min(i, k), Math.max(i, k)]
      setSel(new Set(clips.slice(a, b + 1).map(x => x.key)))
      return
    }
    if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected)
      if (next.has(c.key) && next.size > 1) next.delete(c.key); else next.add(c.key)
      setSel(next)
      goTo(k, true)
      return
    }
    goTo(k)
  }

  // ── Baking ──
  const runBake = async (which: DockedClip[]) => {
    if (bake || !which.length) return
    bakeStop.current = false
    setBake({ text: 'Starting…', stop: false })
    setPlaying(false)
    const node = useFreeNodeStore.getState().nodes[nodeId]
    const made: { url: string; video: boolean; label: string }[] = []
    let failed = 0, lastError = ''
    for (const [n, c] of which.entries()) {
      if (bakeStop.current) break
      const items = itemsFor(c)
      const name = `${c.label} ${styleFor(c)?.name ?? 'look'}`.trim()
      const say = (t: string) => setBake({ text: `Shot ${n + 1} of ${which.length} · ${c.label}${t ? ` · ${t}` : ''}`, stop: bakeStop.current })
      say('')
      if (moves(c)) {
        const r = await makeClip(items, BAKE_SIDE, name, () => bakeStop.current, say, false)
        if ('url' in r) made.push({ url: r.url, video: !!r.video, label: name })
        else if ('error' in r) { failed++; lastError = r.error }
      } else {
        const r = await runChain(items, BAKE_SIDE, false)
        const out = r.outputs[0]
        if (!out) { failed++; lastError = r.error ?? 'nothing came out'; continue }
        const small = window.vidbarsDesktop ? null : downsized(out.canvas, 2048)
        const saved = await saveCanvasImage(out.canvas, 'effect', name, 'jpeg', 0.95, true)
        const url = saved.path ? diskFileUrl(saved.path) : small
        if (url) made.push({ url, video: false, label: name })
        else { failed++; lastError = saved.error ?? 'not saved' }
      }
    }
    // The finished shots as one deck below the mixer, in the deck's order.
    if (made.length && node) {
      const size = cardFaceSize()
      const perRow = 8
      const x0 = node.x + size.w / 2, y0 = node.y + node.height + size.h
      checkpoint()
      const ids = made.map((r, k) => createMediaCard(
        { cx: x0 + (k % perRow) * size.w, cy: y0 + Math.floor(k / perRow) * size.h },
        [{ media: { url: r.url, type: r.video ? 'video' : 'image', originalName: r.label }, label: r.label }]))
      markNew(ids)
    }
    const stopped = bakeStop.current
    setBake({ text: `${made.length} made${failed ? `, ${failed} failed: ${lastError}` : ''}${stopped ? ' (stopped)' : ''}`, stop: false })
    window.setTimeout(() => setBake(null), failed ? 12000 : 5000)
  }

  // ── The look's settings, for the side panel ──
  const look = styleOf(current ?? undefined)
  const rows = look ? styleEffects(tweakedItems(look.items, clip ? shots[clip.key]?.tweaks : undefined)) : []
  const tweaked = (effectId: string, key: string) => !!(clip && shots[clip.key]?.tweaks?.[effectId]?.params && key in shots[clip.key]!.tweaks![effectId].params!)
  const usedBy = (id: string) => clips.filter(c => (styleFor(c)?.id) === id).length
  // Each look its own colour along the film: a card coloured by hand keeps
  // its colour; Style cards in their type's colour take one each from the
  // mixer's set, in the order they are docked.
  const colourOf = (g: ProjectGroup | null) => (!g ? '#3a4046' : g.ownColor && g.color ? g.color : LOOK_COLOURS[Math.max(0, styles.indexOf(g)) % LOOK_COLOURS.length])
  const len = m ? Math.max(1, m.end - m.first) : 1
  const total = clips.reduce((a, c) => a + lenOf(c), 0) || 1

  return (
    <div data-look-mixer="" onPointerDown={e => e.stopPropagation()}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: C.bg }}>
      <div style={{
        position: 'absolute', top: 0, left: (width - W * fit) / 2, width: W, height: H, transform: `scale(${fit})`, transformOrigin: '0 0',
        display: 'grid', gridTemplateColumns: `1fr ${ASIDE}px`, gridTemplateRows: 'auto auto 1fr', color: C.text,
        fontFamily: 'system-ui, sans-serif', fontSize: 13,
      }}>
        {/* ── Header: bake ── */}
        <header style={{ gridColumn: '1 / 3', display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', height: 43, boxSizing: 'border-box', borderBottom: `1px solid ${C.line}`, background: C.panel }}>
          <b style={{ fontSize: 14 }}>Look mixer</b>
          <span style={{ color: C.dim }}>{clips.length} shot{clips.length === 1 ? '' : 's'} · {styles.length} look{styles.length === 1 ? '' : 's'}</span>
          <span data-look-mixer-status style={{ marginLeft: 12, color: C.warn, fontSize: 12, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{bake?.text ?? ''}</span>
          {bake && !/made/.test(bake.text)
            ? <button data-look-mixer-stop style={btn} onClick={() => { bakeStop.current = true; setBake(b => (b ? { ...b, stop: true } : b)) }}>Stop</button>
            : <>
                <button data-look-mixer-bake="selected" style={btn} title="Make the selected shots at full size, as a new deck below the mixer"
                  onClick={() => void runBake(clips.filter(c => selected.has(c.key)))}>Bake selected ({selected.size})</button>
                <button data-look-mixer-bake="all" style={btn} title="Make every shot at full size, as a new deck below the mixer"
                  onClick={() => void runBake(clips)}>Bake all</button>
              </>}
        </header>

        {/* ── Looks, the deck as a film, the shots ── */}
        <div style={{ gridColumn: '1 / 3', borderBottom: `1px solid ${C.line}`, background: C.panel, padding: '6px 12px 4px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 6, minHeight: 26 }}>
            <span style={{ color: C.dim, fontSize: 11, letterSpacing: '.08em', marginRight: 4 }}>LOOKS</span>
            {styles.length === 0 && (
              <span data-look-mixer-no-looks style={{ color: C.dim }}>Dock a Style card with the deck (right-click a loop strip: Make a Style card).</span>
            )}
            {styles.map(g => (
              <button key={g.id} data-look-mixer-look={g.name}
                title={`Give this look to the ${selected.size === 1 ? 'selected shot' : `${selected.size} selected shots`}`}
                onClick={() => giveLook(g.id)}
                style={{ ...btn, fontWeight: 600, border: `1px solid ${current?.id === g.id ? '#fff' : C.line}` }}>
                <i style={{ width: 10, height: 10, borderRadius: 2, background: colourOf(g), display: 'inline-block' }} />
                {g.name}<span style={{ color: C.dim, fontWeight: 400 }}>{usedBy(g.id)}</span>
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', height: 16, borderRadius: 3, overflow: 'hidden', background: C.panel2, marginBottom: 6 }}>
            {clips.map((c, k) => (
              <div key={c.key} onClick={e => pick(k, e)} title={c.label} style={{
                width: `${(lenOf(c) / total) * 100}%`, cursor: 'pointer', boxSizing: 'border-box',
                background: colourOf(styleFor(c)), borderRight: `1px solid ${C.bg}`,
                outline: k === i ? '2px solid #fff' : selected.has(c.key) ? `2px solid ${C.sel}` : 'none', outlineOffset: -2,
              }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 4 }}>
            {clips.map((c, k) => (
              <Tile key={c.key} clip={c} on={k === i} picked={selected.has(c.key)} colour={colourOf(styleFor(c))}
                changed={!!Object.keys(shots[c.key]?.tweaks ?? {}).length} onClick={e => pick(k, e)} />
            ))}
          </div>
        </div>

        {/* ── The picture and its transport ── */}
        <section style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
          <div style={{ flex: 1, minHeight: 0, position: 'relative', background: '#0a0b0c', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {canvas && <CanvasMirror source={canvas} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
            {clip && (
              <div style={{ position: 'absolute', left: 10, top: 8, fontFamily: 'ui-monospace, monospace', fontSize: 12, textShadow: '0 1px 2px #000' }}>
                {clip.label}{current ? ` · ${current.name}` : ' · no look'}
              </div>
            )}
            {m?.note && (
              <div data-look-mixer-note style={{ position: 'absolute', right: 10, top: 8, fontSize: 12, color: C.dim, textShadow: '0 1px 2px #000' }}>{m.note}</div>
            )}
            {m?.error && (
              <div style={{ position: 'absolute', left: 10, bottom: 8, fontSize: 12, color: C.warn, textShadow: '0 1px 2px #000' }}>{m.error}</div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderTop: `1px solid ${C.line}`, background: C.panel, fontVariantNumeric: 'tabular-nums' }}>
            <button style={btn} onClick={() => goTo(Math.max(0, i - 1))} title="The shot before">◀ shot</button>
            <button data-look-mixer-play={playing ? 'on' : 'off'} style={{ ...lit(playing), width: 64, justifyContent: 'center' }} onClick={() => setPlaying(p => !p)}>{playing ? 'Pause' : 'Play'}</button>
            <button style={btn} onClick={() => goTo(Math.min(clips.length - 1, i + 1))} title="The shot after">shot ▶</button>
            <div data-look-mixer-scrub
              title={m ? 'Click to go to a frame' : ''}
              onClick={e => {
                if (!m || !clip || !moves(clip)) return
                const r = e.currentTarget.getBoundingClientRect()
                motionSeek(curKey, m.first + ((e.clientX - r.left) / r.width) * len)
              }}
              style={{ flex: 1, height: 18, background: C.panel2, borderRadius: 3, position: 'relative', overflow: 'hidden', cursor: m ? 'pointer' : 'default' }}>
              {m && <div style={{ position: 'absolute', left: 0, top: 12, height: 6, width: `${(m.drawn / len) * 100}%`, background: 'rgba(140,190,255,0.35)' }} />}
              {m && <div style={{ position: 'absolute', left: 0, top: 0, height: 12, width: `${((m.frame - m.first + 1) / len) * 100}%`, background: '#4a90c8' }} />}
            </div>
            <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, width: 96, textAlign: 'right' }}>{m && clip && moves(clip) ? `${m.frame - m.first + 1} / ${len}` : 'still'}</span>
            <button data-look-mixer-draw style={lit(!!m?.drawAll)} disabled={!m}
              title="Draw every frame of the selected shots through their looks, in the background, so they play smoothly"
              onClick={() => {
                const on = !m?.drawAll
                for (const c of clips) {
                  if (!selected.has(c.key) || !moves(c)) continue
                  const k = keyOf(nodeId, c)
                  if (k !== curKey) motionAttach(k, itemsFor(c))
                  motionDrawAll(k, on)
                }
              }}>{m && m.drawn >= len ? 'Drawn' : 'Draw'}</button>
            <span style={{ color: C.dim, fontSize: 12 }}>{i + 1} / {clips.length}</span>
          </div>
        </section>

        {/* ── The side panel: the shot's look and its settings ── */}
        <aside data-look-mixer-panel style={{ borderLeft: `1px solid ${C.line}`, background: C.panel, overflowY: 'auto', padding: '8px 12px', minHeight: 0 }}>
          <div style={{ color: C.dim, fontSize: 11, letterSpacing: '.08em' }}>
            {selected.size > 1 ? <>CHANGES GO TO <b style={{ color: C.sel, letterSpacing: 0 }}>{selected.size} SHOTS</b></> : <>SHOT <b style={{ color: C.text, letterSpacing: 0 }}>{clip?.label}</b></>}
          </div>
          <div style={{ margin: '8px 0 6px', padding: 8, border: `1px solid ${C.line}`, borderRadius: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            <i style={{ width: 10, height: 10, borderRadius: 2, background: colourOf(current), display: 'inline-block' }} />
            <b>{current?.name ?? 'no look'}</b>
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
            <button style={btn} disabled={!look} title="Make this shot's settings the look's own, for every shot that wears it" onClick={saveToStyle}>Save to the Style card</button>
            <button style={btn} title="Back to the look as it is on its Style card" onClick={clearShot}>Clear changes</button>
            <button style={btn} title="Select every shot, so changes go to all of them" onClick={() => setSel(new Set(clips.map(c => c.key)))}>All shots</button>
          </div>
          {!look && <div style={{ color: C.dim }}>No look on this shot yet.</div>}
          {rows.map(r => {
            const def = EFFECTS[knownKind(r.effect)]
            const vals = effectParams(def.kind, r.params)
            return (
              <div key={r.id} data-look-mixer-effect={def.label} style={{ marginBottom: 10, marginLeft: r.depth * 10, opacity: r.off ? 0.45 : 1 }}>
                <div style={{ color: def.color, fontSize: 11, letterSpacing: '.08em', textTransform: 'uppercase', margin: '6px 0 4px' }}>{def.glyph} {def.label}{r.off ? ' (off)' : ''}</div>
                {def.kind === 'segment' && (
                  <SegmentWords value={r.text ?? ''} onCommit={text => { checkpoint(); setTweak(r.id, { text }) }} />
                )}
                {def.params.map(p => (
                  <Slider key={p.key} p={p} v={vals[p.key]} changed={tweaked(r.id, p.key)}
                    onStart={checkpoint}
                    onChange={v => setTweak(r.id, { key: p.key, v })}
                    onReset={() => resetParam(r.id, p.key)} />
                ))}
              </div>
            )
          })}
        </aside>
      </div>
    </div>
  )
}

const EMPTY: Shots = {}

/** The film mixer's look colours (its mixer.html), for looks that have none of their own. */
const LOOK_COLOURS = ['#5fb3e8', '#e0a040', '#d95f5f', '#7fc98b', '#b58ae6', '#e07ab8', '#4fc4b8', '#c9c14a']

const lenOf = (c: DockedClip) => (c.kind === 'video' ? (Number.isFinite(c.out) ? Math.max(0.1, c.out - c.in) : 4) : STILL_HOLD_S)

function downsized(src: HTMLCanvasElement, side: number): string | null {
  if (!src.width) return null
  const k = Math.min(1, side / Math.max(src.width, src.height))
  const c = document.createElement('canvas')
  c.width = Math.round(src.width * k); c.height = Math.round(src.height * k)
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.92)
}

const Slider: React.FC<{ p: ParamDef; v: number; changed: boolean; onStart: () => void; onChange: (v: number) => void; onReset: () => void }> = ({ p, v, changed, onStart, onChange, onReset }) => (
  <div data-look-mixer-param={p.label} style={{ display: 'grid', gridTemplateColumns: '1fr 64px 16px', gap: '2px 6px', alignItems: 'center', padding: '2px 0' }}>
    <span style={{ gridColumn: '1 / 4', color: changed ? C.sel : C.text }}>{p.label}</span>
    <input type="range" min={p.min} max={p.max} step={p.step} value={v}
      onPointerDown={onStart}
      onChange={e => onChange(Number(e.target.value))} style={{ accentColor: C.accent, width: '100%' }} />
    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, textAlign: 'right', overflow: 'hidden', whiteSpace: 'nowrap' }}>
      {p.names ? p.names[Math.round((v - p.min) / p.step)] ?? v : v.toFixed(p.step >= 1 ? 0 : 2)}
    </span>
    <span title="Back to the look's own value" onClick={onReset} style={{ cursor: 'pointer', color: changed ? C.text : C.line }}>↺</span>
  </div>
)

/** A Segment card's words for this shot (who is in it). Written on leaving
 *  the box: every change draws the masks again. */
const SegmentWords: React.FC<{ value: string; onCommit: (t: string) => void }> = ({ value, onCommit }) => {
  const [t, setT] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) { setSeen(value); setT(value) }
  return (
    <textarea value={t} rows={2} onChange={e => setT(e.target.value)} onBlur={() => { if (t !== value) onCommit(t) }}
      placeholder="What to find, e.g. person"
      style={{ width: '100%', boxSizing: 'border-box', background: C.panel2, color: C.text, border: `1px solid ${C.line}`, borderRadius: 4, fontFamily: 'inherit', fontSize: 12, padding: 4, resize: 'vertical' }} />
  )
}

const Tile: React.FC<{ clip: DockedClip; on: boolean; picked: boolean; colour: string; changed: boolean; onClick: (e: React.MouseEvent) => void }> = ({ clip, on, picked, colour, changed, onClick }) => {
  const src = useResolvedMedia(clip.poster ?? (clip.kind === 'image' ? clip.url : null))
  return (
    <div data-look-mixer-shot={clip.label} onClick={onClick} title={`${clip.label}\nClick: this shot · Shift: a run of shots · Ctrl: add or take away`} style={{
      width: 120, flexShrink: 0, cursor: 'pointer', borderRadius: 4, overflow: 'hidden', boxSizing: 'border-box',
      border: `2px solid ${on ? '#fff' : picked ? C.sel : 'transparent'}`, background: C.panel2,
    }}>
      <div style={{ height: 62, background: src ? `#222 url("${src}") center / cover` : '#2a2c38' }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 5px', fontSize: 11 }}>
        <b style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{clip.label}</b>
        {changed && <span title="This shot has its own settings" style={{ color: C.sel }}>●</span>}
        <span style={{ color: C.dim, fontFamily: 'ui-monospace, monospace' }}>{clip.gif ? 'GIF' : clip.kind === 'video' ? 'vid' : 'pic'}</span>
      </div>
      <div style={{ height: 4, background: colour }} />
    </div>
  )
}
