import React, { useState, useRef, useEffect } from 'react'
import { exportProject, readBackupFile, applyBackup, type ProjectBackup } from '../../utils/projectBackup'

/** Top-bar menu for portable project backup: export the whole project
 *  to a single JSON file, or import one (replacing the current project).
 *  Mirrors TemplateMenu's dropdown + confirm-dialog styling. */
export const ProjectBackupMenu: React.FC = () => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Pending import awaiting confirmation: holds the parsed backup + a label.
  const [pending, setPending] = useState<{ backup: ProjectBackup; name: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const yesBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (!pending) return
    yesBtnRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); setPending(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending])

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    // Reset the input so picking the same file again still fires onChange.
    e.target.value = ''
    if (!file) return
    setError(null)
    try {
      const backup = await readBackupFile(file)
      setPending({ backup, name: file.name })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that file.')
    }
  }

  const btnStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', width: '100%', textAlign: 'left',
    background: 'none', border: 'none', borderRadius: 5,
    color: 'rgba(255,255,255,0.70)', fontSize: 11, fontWeight: 500,
    padding: '7px 10px', cursor: 'pointer', fontFamily: 'inherit',
    letterSpacing: '0.2px', gap: 8,
  }

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Export your project to a file, or import one"
        style={{
          background: open ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 6,
          color: 'rgba(255,255,255,0.55)',
          fontSize: 11, fontWeight: 600,
          padding: '4px 10px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 5,
          fontFamily: 'inherit', letterSpacing: '0.2px',
        }}
      >
        Backup
        <svg width="8" height="5" viewBox="0 0 8 5" fill="none">
          <path d="M1 1l3 3 3-3" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0,
          background: '#1a1b2e', border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: 8, padding: '4px', minWidth: 230, zIndex: 1000,
          boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        }}>
          <div style={{ padding: '4px 10px 2px', fontSize: 9, color: 'rgba(255,255,255,0.28)', letterSpacing: '0.6px', textTransform: 'uppercase' }}>
            Project file
          </div>
          <button
            style={btnStyle}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            onClick={() => { void exportProject(); setOpen(false) }}
          >
            <span style={{ width: 14, textAlign: 'center', opacity: 0.7 }}>⤓</span>
            Export project to file
          </button>
          <button
            style={btnStyle}
            onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,255,255,0.07)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'none')}
            onClick={() => fileInputRef.current?.click()}
          >
            <span style={{ width: 14, textAlign: 'center', opacity: 0.7 }}>⤒</span>
            Import project from file…
          </button>
          <div style={{ padding: '4px 10px 6px', fontSize: 9, color: 'rgba(255,255,255,0.28)', lineHeight: 1.4 }}>
            One self-contained file (includes images). Carry it to another device.
          </div>
          {error && (
            <div style={{ padding: '4px 10px 8px', fontSize: 10, color: 'rgba(255,140,140,0.9)', lineHeight: 1.4 }}>
              {error}
            </div>
          )}
        </div>
      )}

      {/* Hidden file picker for import */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={onPickFile}
      />

      {/* Destructive-import confirmation */}
      {pending && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 2000,
            background: 'rgba(0,0,0,0.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}
          onClick={() => setPending(null)}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#1f2138', border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 10, padding: '18px 20px 14px', minWidth: 300, maxWidth: 440,
              boxShadow: '0 16px 48px rgba(0,0,0,0.6)', fontFamily: 'inherit',
            }}
          >
            <div style={{ color: 'rgba(255,255,255,0.92)', fontSize: 13, lineHeight: 1.45, marginBottom: 6 }}>
              Replace your current project with <strong>{pending.name}</strong>?
            </div>
            <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, lineHeight: 1.45, marginBottom: 14 }}>
              This overwrites everything on your canvas. If you’re unsure, cancel and
              Export a backup of your current project first.
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                onClick={() => setPending(null)}
                style={{
                  background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 5, color: 'rgba(255,255,255,0.7)', fontSize: 11, fontWeight: 500,
                  padding: '6px 14px', cursor: 'pointer', fontFamily: 'inherit',
                }}
              >Cancel</button>
              <button
                ref={yesBtnRef}
                onClick={() => {
                  const b = pending.backup
                  setPending(null)
                  setOpen(false)
                  void applyBackup(b)
                }}
                style={{
                  background: 'rgba(217,122,98,0.35)', border: '1px solid rgba(217,122,98,0.6)',
                  borderRadius: 5, color: 'rgba(255,255,255,0.95)', fontSize: 11, fontWeight: 600,
                  padding: '6px 16px', cursor: 'pointer', fontFamily: 'inherit',
                  outline: 'none', boxShadow: '0 0 0 2px rgba(217,122,98,0.3)',
                }}
              >Replace project</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
