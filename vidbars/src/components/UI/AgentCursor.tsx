import React from 'react'
import { useCanvasStore } from '../../store/canvasStore'
import { AGENT_GLIDE_MS, useAgentCursor } from '../../utils/agentCursor'

const COLOR = '#d97757'

/** The agent's pointer and its bubble (utils/agentCursor). Fixed over
 *  everything, takes no presses. It glides between the spots it is sent to;
 *  while the view itself is being moved it rides along without lag. */
export const AgentCursor: React.FC = () => {
  const { shown, at, text, gliding } = useAgentCursor()
  const pan = useCanvasStore(s => s.pan)
  const zoom = useCanvasStore(s => s.zoom)
  // Kept mounted a moment after it leaves, so it fades instead of vanishing.
  const [mounted, setMounted] = React.useState(false)
  React.useEffect(() => {
    if (shown) { setMounted(true); return }
    const t = setTimeout(() => setMounted(false), 400)
    return () => clearTimeout(t)
  }, [shown])
  if (!shown && !mounted) return null

  const W = window.innerWidth, H = window.innerHeight
  const raw = at ? { x: pan.x + at.x * zoom, y: pan.y + at.y * zoom } : { x: W / 2, y: H / 2 }
  // What it points at may be out of view: it waits at the nearest edge.
  const x = Math.max(12, Math.min(W - 40, raw.x))
  const y = Math.max(12, Math.min(H - 60, raw.y))
  // The bubble sits right of the pointer, or left of it near the right edge.
  const flip = x > W - 300
  return (
    <div data-agent-cursor style={{
      position: 'fixed', left: 0, top: 0, zIndex: 9999, pointerEvents: 'none',
      transform: `translate(${Math.round(x)}px, ${Math.round(y)}px)`,
      transition: !gliding ? 'opacity 300ms' : `transform ${AGENT_GLIDE_MS}ms cubic-bezier(.2,.7,.2,1), opacity 300ms`,
      opacity: shown ? 1 : 0,
    }}>
      <svg width="22" height="22" viewBox="0 0 22 22" style={{ display: 'block', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))' }}>
        <path d="M2 2 L2 17 L6.5 13 L9.5 20 L12.5 18.7 L9.6 12 L15.5 12 Z" fill={COLOR} stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
      <div data-agent-bubble style={{
        position: 'absolute', top: 18, ...(flip ? { right: 4 } : { left: 16 }),
        maxWidth: 260, width: 'max-content', padding: '4px 9px', borderRadius: 9,
        background: COLOR, color: '#fff', fontSize: 12, lineHeight: 1.3, fontWeight: 600,
        boxShadow: '0 2px 8px rgba(0,0,0,0.45)', whiteSpace: 'normal', overflowWrap: 'anywhere',
      }}>
        <span style={{ opacity: 0.8, fontWeight: 500 }}>Claude</span>{text ? ` · ${text}` : ''}
      </div>
    </div>
  )
}
