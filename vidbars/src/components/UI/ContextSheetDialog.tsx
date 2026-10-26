// ContextSheetDialog — make one image of a card (or a deck): its pictures,
// name, summary and notes, sized by the user BEFORE it is made.
//
// The preview and the numbers under it (pixel size, megapixels, estimated
// file size) come from the same layout the final render uses, so what you
// pick is what you get. Very large sheets are allowed but flagged; past what
// a canvas can hold (or the desktop save can carry), Create is refused rather
// than produce a blank file.
// The result is a real file (desktop: Pictures\VidBars Context Sheets) that
// can be dragged straight into a website from here.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import ReactDOM from 'react-dom'
import { useBoardsStore } from '../../store/boardsStore'
import { useCanvasStore } from '../../store/canvasStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useContextSheetStore } from '../../store/contextSheetStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import {
  collectSheet, loadSheetImages, planSheet, renderSheet, estimateBytes, formatBytes,
  canvasLimitHit, type SheetOptions,
} from '../../utils/contextSheet'
import { saveCanvasImage, MAX_SAVE_CHARS, type SaveImageOutcome } from '../../utils/saveImage'
import { diskFileUrl } from '../../utils/diskUrl'
import { DragOutGrip } from './DragOutGrip'

const WIDTHS = [1024, 2048, 4096, 8192, 16384]
/** The width knob's range. The height follows from it, up to what a canvas
 *  can hold (MAX_SIDE / MAX_AREA in contextSheet.ts). */
const MIN_WIDTH = 256, MAX_WIDTH = 16384
/** Past this the sheet is flagged: slow to make, and many upload boxes
 *  refuse files this big. */
const LARGE_MP = 40

export const ContextSheetHost: React.FC = () => {
  const groupIds = useContextSheetStore(s => s.groupIds)
  if (!groupIds || groupIds.length === 0) return null
  return <ContextSheetDialog groupIds={groupIds} />
}

const ContextSheetDialog: React.FC<{ groupIds: string[] }> = ({ groupIds }) => {
  const close = useContextSheetStore(s => s.closeSheet)
  // Content is read once, when the dialog opens: the sheet is a snapshot.
  const sections = useMemo(() => {
    const bs = useBoardsStore.getState()
    const groups = groupIds.map(id => bs.groups.find(g => g.id === id)).filter(g => !!g)
    return collectSheet(groups, bs.boards)
  }, [groupIds])
  const name = sections.length === 1 ? sections[0].title : `${sections[0]?.title ?? 'Deck'} + ${sections.length - 1}`

  const [images, setImages] = useState<Map<string, HTMLImageElement | null> | null>(null)
  useEffect(() => {
    let live = true
    void loadSheetImages(sections).then(m => { if (live) setImages(m) })
    return () => { live = false }
  }, [sections])

  const [width, setWidth] = useState(2048)
  // The width field while it is being typed in: committed on blur or Enter,
  // so '4096' is not clamped to 256 at its first keystroke.
  const [widthDraft, setWidthDraft] = useState<string | null>(null)
  const commitWidth = () => {
    if (widthDraft === null) return
    const n = Math.round(Number(widthDraft))
    if (widthDraft.trim() !== '' && Number.isFinite(n)) setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, n)))
    setWidthDraft(null)
  }
  const [format, setFormat] = useState<'jpeg' | 'png'>('jpeg')
  const [theme, setTheme] = useState<SheetOptions['theme']>('dark')
  const [includeNotes, setIncludeNotes] = useState(true)
  const optionsKey = `${width}|${format}|${theme}|${includeNotes}`
  const plan = useMemo(
    () => images ? planSheet(sections, images, { width, theme, includeNotes }) : null,
    [sections, images, width, theme, includeNotes])

  // Preview: the same plan drawn small.
  const previewRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = previewRef.current
    if (!plan || !host) return
    const scale = Math.min(1, 460 / plan.width, 520 / plan.height)
    const c = renderSheet(plan, scale)
    c.style.display = 'block'
    c.style.maxWidth = '100%'
    host.replaceChildren(c)
  }, [plan])

  const d = window.vidbarsDesktop
  const mp = plan ? plan.width * plan.height / 1e6 : 0
  const [lo, hi] = plan ? estimateBytes(plan.width, plan.height, format) : [0, 0]
  const limit = plan ? canvasLimitHit(plan.width, plan.height) : null
  // The desktop save is one IPC message (see saveImage.ts). Refuse when even
  // the LOW estimate cannot fit, rather than after a long render; a sheet
  // that only turns out too big is still caught once it is encoded.
  const tooBigToSave = !limit && !!d?.saveImage && lo * 4 / 3 > MAX_SAVE_CHARS
  const tooBig = !!limit || tooBigToSave
  const pictureCount = sections.reduce((n, s) => n + s.pictures.length, 0)
  const unreadable = images ? [...images.values()].filter(v => v === null).length : 0

  const [busy, setBusy] = useState(false)
  // What Create made, with the size it was made at and the options it was
  // made with: shown only while those options are still the ones on screen.
  const [result, setResult] = useState<SaveImageOutcome & { w: number; h: number; key: string } | null>(null)
  const shown = result?.key === optionsKey ? result : null

  const create = async () => {
    if (!plan || tooBig) return
    const made = { w: plan.width, h: plan.height, key: optionsKey }
    // Off the button first: disabling a focused element drops focus to
    // <body>, where the app's shortcuts would take keys meant for here.
    rootRef.current?.focus()
    setBusy(true)
    setResult(null)
    // Let the "Making…" state paint before the (possibly long) render.
    await new Promise(r => setTimeout(r, 30))
    try {
      // The full-size canvas is made for this save alone: released once encoded.
      const saved = await saveCanvasImage(renderSheet(plan), 'context-sheet', name, format, 0.9, true)
      setResult({ ...saved, ...made })
    } catch (err) {
      setResult({ path: null, error: String((err as Error)?.message ?? err), ...made })
    } finally {
      setBusy(false)
    }
  }

  const sheetUrl = shown?.path ? diskFileUrl(shown.path) : null
  const putOnCanvas = () => {
    if (!sheetUrl || !shown) return
    const cs = useCanvasStore.getState()
    const cx = (window.innerWidth / 2 - cs.pan.x) / cs.zoom
    const cy = (window.innerHeight / 2 - cs.pan.y) / cs.zoom
    // 240 px wide on screen — narrower when that would run a tall sheet off
    // it. The aspect is the SAVED sheet's, not the plan now on screen.
    const aspect = shown.h / shown.w
    const w = Math.min(240, 0.6 * window.innerWidth, 0.6 * window.innerHeight / aspect) / cs.zoom
    const h = w * aspect
    useUndoCoordinator.getState().checkpoint()
    const fn = useFreeNodeStore.getState()
    const id = fn.addFreeNode(cx - w / 2, cy - h / 2, 'image')
    fn.updateFreeNode(id, { imageUrl: sheetUrl, mediaType: 'image', label: `${name} — context sheet`, width: w, height: h })
    close()
  }

  // Focus lands in the dialog, so keys typed while it is open are its own.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => { rootRef.current?.focus() }, [])

  const btn = (active: boolean): React.CSSProperties => ({
    padding: '4px 9px', borderRadius: 6, cursor: 'pointer', fontSize: 12,
    border: `1px solid ${active ? 'rgba(140,180,255,0.8)' : 'rgba(255,255,255,0.14)'}`,
    background: active ? 'rgba(90,130,230,0.35)' : 'rgba(255,255,255,0.05)', color: '#e2e8f0',
  })
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  // The app's shortcuts listen on document and skip only text fields: Delete
  // with a button here focused would delete the card behind the dialog, and
  // Ctrl+Z undo under it. Stopped here, every key stays the dialog's.
  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation()
    if (e.key === 'Escape' && !busy) close()
  }

  return ReactDOM.createPortal(
    <div
      data-context-sheet
      ref={rootRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Context sheet"
      onPointerDown={stop} onWheel={stop} onContextMenu={stop} onKeyDown={onKeyDown}
      style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif', outline: 'none' }}
      onClick={e => { if (e.target === e.currentTarget && !busy) close() }}
    >
      <div style={{ width: 880, maxWidth: '94vw', maxHeight: '92vh', overflow: 'auto', background: '#1e1f30', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 12, boxShadow: '0 20px 60px rgba(0,0,0,0.6)', color: '#e2e8f0', display: 'flex', gap: 18, padding: 18 }}>
        <div ref={previewRef} style={{ flex: '0 0 460px', minHeight: 200, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', background: 'rgba(0,0,0,0.25)', borderRadius: 8, padding: 6 }}>
          {!plan && <div style={{ padding: 30, opacity: 0.6, fontSize: 13 }}>Loading {pictureCount} picture{pictureCount === 1 ? '' : 's'}…</div>}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700 }}>Context sheet</div>
            <div style={{ fontSize: 12, opacity: 0.6, marginTop: 2 }}>
              {name} · {pictureCount} picture{pictureCount === 1 ? '' : 's'}{unreadable ? ` (${unreadable} unreadable)` : ''}
            </div>
          </div>

          {/* The options hold still while a sheet is being made from them. */}
          <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 12, opacity: busy ? 0.55 : 1 }}>
            <div>
              <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>Width</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                {WIDTHS.map(w => <button key={w} style={btn(width === w)} onClick={() => { setWidth(w); setWidthDraft(null) }}>{w}</button>)}
                <input
                  type="number" min={MIN_WIDTH} max={MAX_WIDTH} step={64} value={widthDraft ?? width}
                  onChange={e => {
                    // Typing is a draft (committed on blur/Enter); the spinner
                    // and arrow keys step a finished value, so the readout
                    // follows them at once. They send no inputType.
                    if ((e.nativeEvent as InputEvent).inputType) setWidthDraft(e.target.value)
                    else {
                      setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Number(e.target.value) || MIN_WIDTH)))
                      setWidthDraft(null)
                    }
                  }}
                  onBlur={commitWidth}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitWidth()
                    // Escape first abandons the typing; a second one closes.
                    else if (e.key === 'Escape' && widthDraft !== null) { e.stopPropagation(); setWidthDraft(null) }
                  }}
                  style={{ width: 76, padding: '4px 6px', borderRadius: 6, border: '1px solid rgba(255,255,255,0.14)', background: 'rgba(0,0,0,0.25)', color: '#e2e8f0', fontSize: 12 }}
                />
                <span style={{ fontSize: 12, opacity: 0.6 }}>px</span>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={btn(format === 'jpeg')} onClick={() => setFormat('jpeg')}>JPEG</button>
                <button style={btn(format === 'png')} onClick={() => setFormat('png')}>PNG</button>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={btn(theme === 'dark')} onClick={() => setTheme('dark')}>Dark</button>
                <button style={btn(theme === 'light')} onClick={() => setTheme('light')}>Light</button>
              </div>
              <label style={{ fontSize: 12, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={includeNotes} onChange={e => setIncludeNotes(e.target.checked)} /> Notes
              </label>
            </div>
          </fieldset>

          {/* The size readout — the point of the dialog. */}
          <div data-sheet-size style={{ padding: 10, borderRadius: 8, background: tooBig ? 'rgba(220,60,60,0.18)' : mp > LARGE_MP ? 'rgba(230,170,40,0.16)' : 'rgba(255,255,255,0.05)', fontSize: 13, lineHeight: 1.5 }}>
            {plan ? <>
              <div><b>{plan.width.toLocaleString()} × {plan.height.toLocaleString()} px</b> · {mp.toFixed(1)} MP</div>
              <div style={{ opacity: 0.75 }}>≈ {formatBytes(lo)} – {formatBytes(hi)} as {format.toUpperCase()}</div>
              {limit && <div style={{ color: '#ff9b9b', marginTop: 4 }}>Too large to make: {limit}. Pick a smaller width.</div>}
              {tooBigToSave && <div style={{ color: '#ff9b9b', marginTop: 4 }}>Too large to save: at least {formatBytes(lo)} as {format.toUpperCase()}, more than the desktop can hand over in one piece. Pick {format === 'png' ? 'JPEG or ' : ''}a smaller width.</div>}
              {!tooBig && mp > LARGE_MP && <div style={{ color: '#ffd27a', marginTop: 4 }}>Very large: slow to make, and many upload boxes refuse files this size.</div>}
            </> : 'Measuring…'}
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              data-sheet-create
              disabled={!plan || tooBig || busy}
              onClick={create}
              style={{ ...btn(true), padding: '7px 14px', fontSize: 13, opacity: !plan || tooBig || busy ? 0.5 : 1, cursor: !plan || tooBig || busy ? 'default' : 'pointer' }}
            >{busy ? 'Making…' : d?.saveImage ? 'Create sheet' : 'Create & download'}</button>
            <button style={{ ...btn(false), padding: '7px 14px', fontSize: 13 }} onClick={close} disabled={busy}>Close</button>
          </div>

          {shown?.error && <div style={{ color: '#ff9b9b', fontSize: 12 }}>Not made: {shown.error}</div>}
          {shown?.downloaded && <div data-sheet-downloaded style={{ fontSize: 12, opacity: 0.85 }}>Handed to the browser's downloads.</div>}
          {shown?.path && sheetUrl && (
            <div data-sheet-result style={{ padding: 10, borderRadius: 8, background: 'rgba(80,200,120,0.12)', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ wordBreak: 'break-all', opacity: 0.85 }}>Saved: {shown.path}</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px', borderRadius: 6, background: 'rgba(255,255,255,0.08)' }}>
                  <DragOutGrip url={sheetUrl} size={20} /> drag into a site
                </span>
                <button style={btn(false)} onClick={() => { void d?.revealPath(shown.path!) }}>Show in Explorer</button>
                <button style={btn(false)} onClick={() => { void d?.copyPath(shown.path!) }}>Copy path</button>
                <button style={btn(false)} onClick={putOnCanvas}>Put on canvas</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
