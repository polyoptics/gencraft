// HistoryPanel.tsx — its own app, on purpose.
//
// Folding history into the Media Pool would have been less code and the
// wrong shape: a history is not "the pool's second tab", it is a lens, and
// which history you want depends on what you dock it to. So this panel
// derives its kinds from its neighbours — Prompt Pad → prompts, Media Pool
// → folders, Rolodex/Viewer → things opened — and shows everything when it
// stands alone. Same idea as the Viewer showing whatever media reaches it.
//
// Entries are replayable, and replay goes to the neighbour: clicking a
// prompt loads it into the attached pad, clicking a folder points the
// attached pool at it. With nothing attached, clicking places the item on
// the canvas instead, so the panel is never inert.

import React, { useMemo, useState } from 'react'
import { useHistoryStore, type HistoryKind, type HistoryEntry } from '../../store/historyStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { adjacentPanels } from '../../utils/componentLinks'
import { CounterScaled, usePanelChrome } from '../UI/PanelSurface'
import { cssUrl } from '../../utils/diskUrl'

const KIND_GLYPH: Record<HistoryKind, string> = {
  prompt: '✎', view: '◉', folder: '📁', place: '＋',
}

const KIND_LABEL: Record<HistoryKind, string> = {
  prompt: 'Prompts', view: 'Opened', folder: 'Folders', place: 'Placed',
}

const ALL_KINDS: HistoryKind[] = ['prompt', 'view', 'folder', 'place']

/** Which kinds a neighbouring panel implies. */
function kindsForNeighbour(type: string): HistoryKind[] {
  if (type === 'prompt' || type === 'promptCards') return ['prompt']
  if (type === 'pool') return ['folder']
  if (type === 'list') return ['view', 'place']
  return []
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

export const HistoryPanel: React.FC<{ nodeId: string }> = ({ nodeId }) => {
  const node = useFreeNodeStore(s => s.nodes[nodeId])
  const nodes = useFreeNodeStore(s => s.nodes)
  const { surface, showControls } = usePanelChrome(node)
  const updateFreeNode = useFreeNodeStore(s => s.updateFreeNode)
  const entries = useHistoryStore(s => s.entries)
  const remove = useHistoryStore(s => s.remove)
  const clear = useHistoryStore(s => s.clear)
  const [filter, setFilter] = useState('')
  /** null = follow the neighbours; a kind = the user overrode it. */
  const [pinnedKind, setPinnedKind] = useState<HistoryKind | null>(null)

  const neighbours = useMemo(
    () => (node ? adjacentPanels(node, nodes) : []),
    [node, nodes],
  )

  // The docked kinds, and the neighbour we replay INTO.
  const { derivedKinds, host } = useMemo(() => {
    for (const n of neighbours) {
      const k = kindsForNeighbour(n.type)
      if (k.length) return { derivedKinds: k, host: n }
    }
    return { derivedKinds: ALL_KINDS, host: null as ReturnType<typeof Object> | null }
  }, [neighbours])

  const activeKinds = pinnedKind ? [pinnedKind] : derivedKinds

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return entries
      .filter(e => activeKinds.includes(e.kind))
      .filter(e => !q || e.label.toLowerCase().includes(q))
  }, [entries, activeKinds, filter])

  /** Replay: hand the entry back to the attached app, or to the canvas. */
  const replay = (e: HistoryEntry) => {
    const hostNode = host as { id: string; type: string } | null
    if (e.kind === 'prompt' && (hostNode?.type === 'prompt' || hostNode?.type === 'promptCards')) {
      updateFreeNode(hostNode.id, { text: e.prompt ?? e.label })
      return
    }
    if (e.kind === 'folder' && hostNode?.type === 'pool') {
      updateFreeNode(hostNode.id, { poolDir: e.dir ?? '' })
      return
    }
    // Nothing to hand it to: put it back on the canvas where it can be seen.
    if (e.url && e.mediaType) {
      const cs = useCanvasStore.getState()
      const fns = useFreeNodeStore.getState()
      useUndoCoordinator.getState().checkpoint()
      const cx = (window.innerWidth / 2 - cs.pan.x) / cs.zoom
      const cy = (window.innerHeight / 2 - cs.pan.y) / cs.zoom
      const id = fns.addFreeNode(cx, cy, e.mediaType)
      fns.updateFreeNode(id, { imageUrl: e.url, mediaType: e.mediaType, label: e.label })
      fns.setFreeSelection([id])
    }
  }

  const chip = (on: boolean): React.CSSProperties => ({
    background: on ? 'rgba(120,170,255,0.28)' : 'rgba(255,255,255,0.05)',
    border: `1px solid ${on ? 'rgba(140,190,255,0.55)' : 'rgba(255,255,255,0.1)'}`,
    borderRadius: 4, color: on ? '#dce9ff' : 'rgba(255,255,255,0.55)',
    fontSize: 11, fontWeight: 700, letterSpacing: '0.3px',
    padding: '2px 7px', cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
  })

  const hostType = (host as { type: string } | null)?.type

  return (
    <div
      onPointerDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      data-wheel-own=""
      style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#12131f' }}
    >
      {/* Screen-pixel chrome at any zoom — see PanelSurface. The kind chips
          and the search row are the first things to go when the window is
          too short on screen to afford them; the entries keep the space. */}
      <CounterScaled gz={surface}>
      <div style={{
        width: '100%', height: '100%', display: 'flex', flexDirection: 'column',
        overflow: 'hidden', fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* ── What this history currently IS ── */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 4, padding: '4px 6px',
        borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0,
      }}>
        <span style={{
          fontSize: 11, fontWeight: 700, letterSpacing: '0.6px',
          textTransform: 'uppercase', color: 'rgba(255,255,255,0.4)',
        }}>History</span>
        {hostType && !pinnedKind && (
          <span style={{
            fontSize: 10.5, color: 'rgba(150,200,255,0.75)',
            background: 'rgba(120,170,255,0.14)', borderRadius: 3, padding: '1px 5px',
          }}>▸ {hostType === 'prompt' ? 'prompt pad' : hostType === 'pool' ? 'media pool' : 'rolodex'}</span>
        )}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>{shown.length}</span>
      </div>

      {/* ── Kind chips: derived by default, overridable ── */}
      {showControls && <div style={{
        display: 'flex', alignItems: 'center', gap: 3, padding: '4px 6px',
        borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0, flexWrap: 'wrap',
      }}>
        <button style={chip(pinnedKind === null)} onClick={() => setPinnedKind(null)}
          title="Follow whatever this window is docked to">AUTO</button>
        {ALL_KINDS.map(k => (
          <button key={k} style={chip(pinnedKind === k)}
            onClick={() => setPinnedKind(pinnedKind === k ? null : k)}>
            {KIND_GLYPH[k]} {KIND_LABEL[k]}
          </button>
        ))}
      </div>}

      {showControls && <div style={{
        display: 'flex', alignItems: 'center', gap: 3, padding: '4px 6px',
        borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0,
      }}>
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          onKeyDown={e => e.stopPropagation()}
          placeholder="search history…"
          style={{
            flex: 1, minWidth: 40, background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)', borderRadius: 3,
            color: 'rgba(255,255,255,0.85)', fontSize: 11.5, padding: '2px 6px',
            fontFamily: 'inherit', outline: 'none',
          }}
        />
        <button style={chip(false)} title="Clear what is shown"
          onClick={() => { for (const k of activeKinds) clear(k) }}>CLEAR</button>
      </div>}

      {/* ── Entries ── */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '3px 0' }}>
        {shown.length === 0 && (
          <div style={{
            color: 'rgba(255,255,255,0.3)', fontSize: 10, padding: 12, lineHeight: 1.6,
          }}>
            Nothing here yet. Magnet this window to a Prompt Pad, a Media Pool
            or a Rolodex and it shows that kind of history.
          </div>
        )}
        {shown.map(e => (
          <div
            key={e.id}
            onClick={() => replay(e)}
            title={e.kind === 'prompt' ? 'Load this prompt' : e.kind === 'folder' ? 'Go back to this folder' : 'Open again'}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 6px', cursor: 'pointer',
              borderLeft: '2px solid rgba(140,190,255,0.35)',
              margin: '0 5px 3px', borderRadius: 3,
              background: 'rgba(255,255,255,0.03)',
            }}
          >
            {e.face
              ? <div style={{
                  width: 22, height: 22, flexShrink: 0, borderRadius: 3,
                  background: `#0c0e18 center/cover no-repeat ${cssUrl(e.face)}`,
                }} />
              : <span style={{ fontSize: 11, opacity: 0.5, width: 14, textAlign: 'center', flexShrink: 0 }}>
                  {KIND_GLYPH[e.kind]}
                </span>}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                fontSize: 11.5, color: 'rgba(255,255,255,0.78)', lineHeight: 1.35,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>{e.label}</div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.28)' }}>
                {KIND_LABEL[e.kind].toLowerCase()} · {ago(e.at)} ago
              </div>
            </div>
            <button
              onClick={ev => { ev.stopPropagation(); remove(e.id) }}
              title="Forget this entry"
              style={{
                background: 'none', border: 'none', color: 'rgba(255,255,255,0.25)',
                fontSize: 11, cursor: 'pointer', padding: '0 2px', flexShrink: 0,
                fontFamily: 'inherit',
              }}
            >×</button>
          </div>
        ))}
      </div>
      </div>
      </CounterScaled>
    </div>
  )
}
