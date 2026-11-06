// PromptCardMenu — under the top bar's Prompt card button: a blank Prompt
// card, one of the ready-made ones, or all of them as a deck
// (utils/promptCards). Like the Effects palette: portalled to <body>,
// screen size, a press anywhere else or Escape closes it.

import React from 'react'
import ReactDOM from 'react-dom'
import { PROMPT_PRESETS, makePromptCard, makePromptDeck } from '../../utils/promptCards'

const W = 250

export const PromptCardMenu = React.memo(function PromptCardMenu({ open, anchorRef, onClose }: {
  open: boolean
  anchorRef: React.RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const boxRef = React.useRef<HTMLDivElement>(null)
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null)

  React.useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const r = anchorRef.current?.getBoundingClientRect()
      if (!r) return
      const left = r.left + r.width / 2 - W / 2
      setPos({ left: Math.max(8, Math.min(window.innerWidth - W - 8, left)), top: r.bottom + 6 })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open, anchorRef])

  React.useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (t && (boxRef.current?.contains(t) || anchorRef.current?.contains(t))) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open, anchorRef, onClose])

  if (!open || !pos) return null
  const item = (key: string, label: string, sub: string | null, run: () => void) => (
    <div
      key={key}
      data-prompt-card-item={label}
      className="pcm-item"
      onClick={() => { run(); onClose() }}
      style={{ padding: '7px 10px', borderRadius: 7, cursor: 'pointer' }}
    >
      <div style={{ fontSize: 13, color: 'rgba(232,238,255,0.92)' }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: 'rgba(232,238,255,0.35)', marginTop: 1 }}>{sub}</div>}
    </div>
  )
  return ReactDOM.createPortal(
    <div
      ref={boxRef}
      style={{
        position: 'fixed', left: pos.left, top: pos.top, width: W, zIndex: 1000, padding: 5, boxSizing: 'border-box',
        background: '#181a26', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12,
        boxShadow: '0 12px 34px rgba(0,0,0,0.6)', fontFamily: 'system-ui, sans-serif',
      }}
    >
      <style>{'.pcm-item:hover { background: rgba(31,155,180,0.2) }'}</style>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', color: '#5fd0e6', padding: '4px 10px 6px' }}>Prompt card</div>
      {item('blank', 'Blank', 'Fill in its rows yourself', () => makePromptCard())}
      {PROMPT_PRESETS.map(p => item(p.name, p.name, p.rows.map(r => r[0]).join(' · '), () => makePromptCard(p)))}
      <div style={{ height: 1, background: 'rgba(255,255,255,0.08)', margin: '4px 6px' }} />
      {item('deck', 'All of them, as a deck', 'The ready-made cards, side by side', () => makePromptDeck())}
    </div>,
    document.body,
  )
})
