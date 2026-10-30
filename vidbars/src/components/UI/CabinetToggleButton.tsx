// CabinetToggleButton — on the top bar: show or hide the project cabinets.
// Off hides them and their menu items and deletes nothing: everything in their
// drawers is still there when they come back.

import React from 'react'
import { useCabinetUi } from '../../utils/cabinet'

export const CabinetToggleButton: React.FC = () => {
  const on = useCabinetUi(s => s.enabled)
  return (
    <button
      onClick={() => useCabinetUi.getState().setEnabled(!on)}
      title={on
        ? 'Cabinets are showing. Click to hide them; nothing in them is deleted.'
        : 'Cabinets are hidden. Click to show them.'}
      style={{
        height: 24,
        padding: '0 8px',
        display: 'flex', alignItems: 'center', gap: 5,
        background: on ? 'rgba(98,160,217,0.22)' : 'rgba(255,255,255,0.05)',
        border: on ? '1px solid rgba(98,160,217,0.5)' : '1px solid rgba(255,255,255,0.1)',
        borderRadius: 6,
        color: on ? '#9ecbff' : 'rgba(255,255,255,0.6)',
        fontSize: 11, fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <span style={{ fontSize: 13 }}>🗄️</span>
      Cabinets
    </button>
  )
}
