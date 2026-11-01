// RenameInput — the one way a name is edited, wherever it sits on the canvas.
//
// A field inside the zoomed world is scaled with it: at card zoom its caret is
// a fraction of a pixel and cannot be seen, and its text may be too small to
// read. So what is typed in lies over the canvas at a steady screen size, just
// over where the name is, following it if the view moves. A hidden twin keeps
// the name's place in its own layout.
//
// Takes an <input>'s props, so a rename field only swaps its tag. The name comes
// selected, a click anywhere else leaves the field (the owner's onBlur saves),
// and no key or press reaches the canvas behind it.

import React, { useEffect, useImperativeHandle, useRef, useState } from 'react'
import ReactDOM from 'react-dom'

const FONT = 13
const MIN_W = 150

const stop = (e: React.SyntheticEvent) => e.stopPropagation()

/** The field's look on screen, the same at every zoom. */
function fieldStyle(el: HTMLInputElement) {
  el.style.cssText = [
    'position:fixed', 'z-index:10000', 'box-sizing:border-box', 'height:24px', 'padding:0 6px',
    `font:600 ${FONT}px system-ui,sans-serif`, 'color:#fff', 'caret-color:#fff',
    'background:#14161f', 'border:1px solid rgba(120,180,255,0.9)', 'border-radius:4px', 'outline:none',
    'box-shadow:0 4px 14px rgba(0,0,0,0.6)',
  ].join(';')
}

export const RenameInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ style, className: _className, autoFocus: _autoFocus, ...rest }, ref) => {
    const field = useRef<HTMLInputElement>(null)
    const twin = useRef<HTMLInputElement>(null)
    const [ready, setReady] = useState(false)
    // Escape means no change, whatever losing focus on the way out would do.
    const cancelled = useRef(false)
    useImperativeHandle(ref, () => field.current as HTMLInputElement)
    useEffect(() => setReady(true), [])

    useEffect(() => {
      const el = field.current
      if (!el || !ready) return
      fieldStyle(el)
      let raf = 0
      const place = () => {
        const r = twin.current?.getBoundingClientRect()
        if (r) {
          const w = Math.max(MIN_W, r.width)
          el.style.width = `${w}px`
          el.style.left = `${Math.max(4, Math.min(window.innerWidth - w - 4, r.left))}px`
          el.style.top = `${Math.max(4, Math.min(window.innerHeight - 28, r.top + r.height / 2 - 12))}px`
        }
        raf = requestAnimationFrame(place)
      }
      place()
      el.focus()
      el.select()
      // Plenty on the canvas cancels its presses, which would leave focus here.
      const away = (e: PointerEvent) => { if (e.target !== el) el.blur() }
      window.addEventListener('pointerdown', away, true)
      return () => {
        cancelAnimationFrame(raf)
        window.removeEventListener('pointerdown', away, true)
      }
    }, [ready])

    return (
      <>
        <input ref={twin} readOnly tabIndex={-1} aria-hidden value={String(rest.value ?? '')} style={{ ...style, visibility: 'hidden' }} />
        {ready && ReactDOM.createPortal(
          <input
            {...rest}
            ref={field}
            onPointerDown={stop}
            onMouseDown={stop}
            onClick={stop}
            onDoubleClick={stop}
            onContextMenu={stop}
            onBlur={e => { if (!cancelled.current) rest.onBlur?.(e) }}
            onKeyDown={e => {
              e.stopPropagation()
              if (e.key === 'Escape') cancelled.current = true
              rest.onKeyDown?.(e)
            }}
            onKeyUp={stop}
          />,
          document.body,
        )}
      </>
    )
  },
)
RenameInput.displayName = 'RenameInput'

/** The same field where there is no name on screen to sit over: opened by a
 *  menu, at a point. Replaces window.prompt, which the desktop app does not have. */
export function askText(initial: string, x: number, y: number, commit: (value: string) => void) {
  const el = document.createElement('input')
  el.value = initial
  fieldStyle(el)
  const w = 260
  el.style.width = `${w}px`
  el.style.left = `${Math.max(4, Math.min(window.innerWidth - w - 4, x))}px`
  el.style.top = `${Math.max(4, Math.min(window.innerHeight - 28, y))}px`
  let done = false
  const finish = (save: boolean) => {
    if (done) return
    done = true
    window.removeEventListener('pointerdown', away, true)
    el.remove()
    if (save) commit(el.value)
  }
  const away = (e: PointerEvent) => { if (e.target !== el) finish(true) }
  el.addEventListener('blur', () => finish(true))
  el.addEventListener('keydown', e => {
    e.stopPropagation()
    if (e.key === 'Enter') finish(true)
    if (e.key === 'Escape') finish(false)
  })
  el.addEventListener('pointerdown', e => e.stopPropagation())
  document.body.appendChild(el)
  window.addEventListener('pointerdown', away, true)
  el.focus()
  el.select()
}
