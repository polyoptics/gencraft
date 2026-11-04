import React from 'react'
import { useTiltStore, DEFAULT_LIGHT } from '../../../store/tiltStore'

/** The Light panel: drag the dot round the dial to move the key light (the
 *  angle is where it comes from round the card, the distance from the
 *  centre how low it is: centre = straight overhead, rim = level with the
 *  card), plus brightness, reflections, and whether it turns with the
 *  turntable. Changes show live on every model. */
export function LightPanel({ onClose }: { onClose: () => void }) {
  const light = useTiltStore(s => s.light)
  const setLight = useTiltStore(s => s.setLight)
  const R = 54
  const az = light.azimuth * Math.PI / 180
  const r = R * (1 - Math.max(0, Math.min(90, light.elevation)) / 90)
  const dot = { x: R + Math.sin(az) * r, y: R + Math.cos(az) * r }
  const aim = (e: React.PointerEvent<SVGSVGElement>) => {
    const b = e.currentTarget.getBoundingClientRect()
    const dx = e.clientX - b.left - R, dy = e.clientY - b.top - R
    const d = Math.min(R, Math.hypot(dx, dy))
    setLight({ azimuth: Math.atan2(dx, dy) * 180 / Math.PI, elevation: 90 * (1 - d / R) })
  }
  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }
  return (
    <div
      data-tilt-hud
      style={{
        position: 'absolute', left: '50%', bottom: 60, transform: 'translateX(-50%)',
        display: 'flex', gap: 14, padding: '10px 12px', alignItems: 'center',
        background: 'rgba(19,20,31,0.94)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10,
        color: 'rgba(255,255,255,0.7)', userSelect: 'none', pointerEvents: 'auto',
      }}
    >
      <svg
        width={R * 2} height={R * 2} style={{ cursor: 'crosshair', touchAction: 'none', flexShrink: 0 }}
        onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); aim(e) }}
        onPointerMove={e => { if (e.buttons & 1) aim(e) }}
      >
        <circle cx={R} cy={R} r={R - 1} fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.18)" />
        <circle cx={R} cy={R} r={R / 2} fill="none" stroke="rgba(255,255,255,0.08)" />
        <rect x={R - 9} y={R - 6} width={18} height={12} rx={2} fill="rgba(255,255,255,0.12)" />
        <line x1={R} y1={R} x2={dot.x} y2={dot.y} stroke="rgba(255,220,140,0.35)" />
        <circle cx={dot.x} cy={dot.y} r={7} fill="#ffd98a" stroke="#fff" strokeWidth={1} />
      </svg>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 170 }}>
        <div style={row}>
          <span style={{ width: 70 }}>Brightness</span>
          <input type="range" min={0} max={6} step={0.05} value={light.power}
            onChange={e => setLight({ power: +e.target.value })} style={{ flex: 1 }} />
        </div>
        <div style={row}>
          <span style={{ width: 70 }}>Reflections</span>
          <input type="range" min={0} max={2.5} step={0.05} value={light.env}
            onChange={e => setLight({ env: +e.target.value })} style={{ flex: 1 }} />
        </div>
        <div style={row}>
          <span style={{ width: 70 }}>Shadows</span>
          <input type="range" min={0} max={1} step={0.02} value={light.shadows ?? DEFAULT_LIGHT.shadows}
            onChange={e => setLight({ shadows: +e.target.value })} style={{ flex: 1 }} />
        </div>
        <div style={row}>
          <span style={{ width: 70 }}>Sheen</span>
          <input type="range" min={0} max={1} step={0.02} value={light.sheen ?? DEFAULT_LIGHT.sheen}
            onChange={e => setLight({ sheen: +e.target.value })} style={{ flex: 1 }} />
        </div>
        <label style={{ ...row, cursor: 'pointer' }}>
          <input type="checkbox" checked={!!light.soft} onChange={e => setLight({ soft: e.target.checked })} />
          Soft shadow edges
        </label>
        <label style={{ ...row, cursor: 'pointer' }}>
          <input type="checkbox" checked={light.spin} onChange={e => setLight({ spin: e.target.checked })} />
          Light turns with the turntable
        </label>
        <div style={{ ...row, justifyContent: 'space-between' }}>
          <button onClick={() => setLight(DEFAULT_LIGHT)} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6, color: 'rgba(255,255,255,0.6)', fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}>Reset</button>
          <button onClick={onClose} style={{ background: 'transparent', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 6, color: 'rgba(255,255,255,0.6)', fontSize: 11, padding: '2px 8px', cursor: 'pointer' }}>Done</button>
        </div>
      </div>
    </div>
  )
}
