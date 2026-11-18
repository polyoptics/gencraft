import React from 'react'
import { addChatBox, closeChatBox, moveChatBox, newChat, sendChat, stopChat, useAgentChat, type ChatBox } from '../../utils/agentChat'

// How a box looks and where the boxes sit: all of it is here, so it is easy
// to change (Brian decides both). Every box is one fixed size; nothing in
// it moves or resizes as the talk goes on. Until a box is dragged by its
// header it sits in a row along the bottom, from the right.
const BOX = { right: 46, bottom: 54, width: 360, height: 480, gap: 12 }
const ACCENT = '#d97757'

const bubble = (who: string): React.CSSProperties => who === 'me'
  ? { alignSelf: 'flex-end', background: 'rgba(120,170,255,0.2)', border: '1px solid rgba(120,170,255,0.3)', color: '#fff' }
  : who === 'error'
    ? { alignSelf: 'flex-start', background: 'rgba(255,90,90,0.14)', border: '1px solid rgba(255,90,90,0.35)', color: '#ffc9c9' }
    : { alignSelf: 'flex-start', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.92)' }

/** Claude's words with **bold** shown as bold; everything else as written. */
const words = (text: string): React.ReactNode =>
  text.split(/(\*\*[^*\n]+\*\*)/g).map((part, i) =>
    /^\*\*[^*\n]+\*\*$/.test(part) ? <b key={i}>{part.slice(2, -2)}</b> : part)

const small: React.CSSProperties = {
  background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.8)',
  borderRadius: 6, fontSize: 11, padding: '3px 8px', cursor: 'pointer',
}

/** One chat box: its own lines, its own conversation with Claude. */
const Box: React.FC<{ box: ChatBox; index: number; count: number }> = ({ box, index, count }) => {
  const busy = useAgentChat(s => !!s.busy[box.id])
  const [draft, setDraft] = React.useState('')
  const listRef = React.useRef<HTMLDivElement>(null)
  // The newest line stays in view.
  React.useEffect(() => { const el = listRef.current; if (el) el.scrollTop = el.scrollHeight }, [box.lines, busy])

  const send = () => { if (!draft.trim() || busy) return; void sendChat(box.id, draft); setDraft('') }
  // Its place: where it was dragged to, or its turn in the row from the right.
  const place: React.CSSProperties = box.at
    ? { left: Math.max(0, Math.min(window.innerWidth - 80, box.at.x)), top: Math.max(0, Math.min(window.innerHeight - 40, box.at.y)) }
    : { right: BOX.right + index * (BOX.width + BOX.gap), bottom: BOX.bottom }
  // Dragged by its header; it follows the mouse, and stays where it is let go.
  const drag = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return
    const el = e.currentTarget.parentElement!
    const r = el.getBoundingClientRect()
    const dx = e.clientX - r.left, dy = e.clientY - r.top
    const move = (ev: PointerEvent) => moveChatBox(box.id, { x: ev.clientX - dx, y: ev.clientY - dy })
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    e.preventDefault()
  }
  return (
    <div
      data-agent-chat={box.id}
      // Typing and scrolling here are the box's own, not the canvas's.
      onKeyDown={e => e.stopPropagation()}
      onWheel={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      style={{
        position: 'fixed', ...place, width: BOX.width, height: BOX.height, zIndex: 9000,
        display: 'flex', flexDirection: 'column', boxSizing: 'border-box',
        background: 'rgba(20,21,27,0.97)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 12,
        boxShadow: '0 12px 40px rgba(0,0,0,0.55)', color: '#fff', fontSize: 13, overflow: 'hidden',
      }}
    >
      <div onPointerDown={drag} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 10px 9px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)', flexShrink: 0, cursor: 'grab', userSelect: 'none' }}>
        <span style={{ width: 9, height: 9, borderRadius: 5, background: ACCENT, flexShrink: 0 }} />
        <span style={{ fontWeight: 600, flex: 1 }}>Claude{count > 1 ? ` ${index + 1}` : ''}</span>
        <button style={small} title="Another chat box, with a history of its own" onClick={addChatBox}>New box</button>
        <button style={small} title="Start a fresh conversation in this box: Claude will not remember this one" onClick={() => newChat(box.id)}>New conversation</button>
        <button style={small} title={count > 1 ? 'Close this box: what was said in it goes' : 'Put the box away'} aria-label="Close" onClick={() => closeChatBox(box.id)}>✕</button>
      </div>
      <div ref={listRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
        {box.lines.length === 0 && (
          <div style={{ margin: 'auto', textAlign: 'center', color: 'rgba(255,255,255,0.45)', lineHeight: 1.5, padding: '0 18px' }}>
            Ask Claude to work on the canvas with you. It can read your cards and decks, make new ones, and change what you ask it to.
          </div>
        )}
        {box.lines.map(l => l.who === 'did'
          ? <div key={l.id} style={{ alignSelf: 'flex-start', color: ACCENT, fontSize: 11.5, padding: '0 4px' }}>▸ {l.text}</div>
          : <div key={l.id} style={{ ...bubble(l.who), maxWidth: '88%', padding: '7px 10px', borderRadius: 10, lineHeight: 1.4, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'text' }}>{l.who === 'claude' ? words(l.text) : l.text}</div>)}
      </div>
      {/* One line of fixed height, always there, so nothing shifts when Claude starts or stops. */}
      <div style={{ height: 20, padding: '0 14px', fontSize: 11.5, color: 'rgba(255,255,255,0.5)', flexShrink: 0 }}>{busy ? 'Claude is working…' : ''}</div>
      <div style={{ display: 'flex', gap: 8, padding: '0 10px 10px', flexShrink: 0 }}>
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder="Say something to Claude"
          rows={2}
          style={{
            flex: 1, resize: 'none', height: 46, boxSizing: 'border-box', background: 'rgba(255,255,255,0.06)',
            border: '1px solid rgba(255,255,255,0.12)', borderRadius: 8, color: '#fff', padding: '6px 9px', fontSize: 13,
            fontFamily: 'inherit', outline: 'none',
          }}
        />
        {/* Send and Stop are two buttons side by side; each is lit only when it can be used. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 54 }}>
          <button
            onClick={send} disabled={busy || !draft.trim()}
            style={{ flex: 1, borderRadius: 6, border: 'none', fontSize: 12, fontWeight: 600, cursor: busy || !draft.trim() ? 'default' : 'pointer', background: ACCENT, color: '#fff', opacity: busy || !draft.trim() ? 0.35 : 1 }}
          >Send</button>
          <button
            onClick={() => stopChat(box.id)} disabled={!busy}
            style={{ flex: 1, borderRadius: 6, border: '1px solid rgba(255,255,255,0.2)', fontSize: 12, cursor: busy ? 'pointer' : 'default', background: 'transparent', color: '#fff', opacity: busy ? 1 : 0.35 }}
          >Stop</button>
        </div>
      </div>
    </div>
  )
}

/** The chat boxes (utils/agentChat): talk to Claude, who works on the canvas. */
export const AgentChat: React.FC = () => {
  const open = useAgentChat(s => s.open)
  const boxes = useAgentChat(s => s.boxes)
  if (!open) return null
  return <>{boxes.map((b, i) => <Box key={b.id} box={b} index={i} count={boxes.length} />)}</>
}
