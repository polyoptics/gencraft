// TopIconBar — the icon strip that sits over the toolbar.
//
// Icons only, deliberately large: these are the things you reach for
// constantly while building, and a ~1cm target is the size a tool palette
// wants. Names live in the tooltip, not on the button.
//
// It is CENTRED and FIXED to the top of the screen, floating above the
// toolbar rather than taking a row of its own — the toolbar's own controls
// live at its far left and far right, so the middle was dead space.
//
// Drawing style: duotone. One pale structural stroke carries the shape, one
// vivid flat accent carries the meaning. On a light tile the structure would
// be near-black; on black it inverts to near-white, and the accents stay
// saturated so they read at a glance in a row of seven.
//
// Everything here creates something ON THE CANVAS, centred in the viewport,
// via utils/canvasCreate so a button and the canvas right-click menu can
// never produce different results.

import React from 'react'
import {
  addFreeNodeCentered,
  addBrowserNode,
  addViewerCentered,
  createCardOrBoardAt,
  createStorylineAt,
} from '../../utils/canvasCreate'
import { EffectPalette } from './EffectPalette'
import { useZoomZone } from '../../store/zoomZonesStore'
import { useCabinetUi } from '../../utils/cabinet'
import { openFilmMixer } from '../FilmMixer/FilmMixerBody'

/** Tile edge in px. A shade over 1cm on a typical desktop monitor. */
const TILE = 44
/** The glyph inside the tile. */
const GLYPH = 26

/** Structural stroke — carries the shape. */
const S = 'rgba(228,234,255,0.92)'
/** Accents — flat fills, one per icon, so the row reads as seven things. */
const A = {
  green:  '#5FE39B',
  cyan:   '#4FC3FF',
  yellow: '#FFD24A',
  coral:  '#FF7C6B',
  violet: '#A98BFF',
  pink:   '#FF8FD1',
}


type SvgProps = { size: number }
const svgBase = (size: number) => ({
  width: size, height: size, viewBox: '0 0 24 24',
  fill: 'none' as const,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  strokeWidth: 2,
})

/** Viewer — a screen showing something. Accent: the play triangle. */
const IcViewer: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <rect x="2.5" y="4" width="19" height="13" rx="2.5" stroke={S} />
    <path d="M9 21h6" stroke={S} />
    <path d="M12 17v4" stroke={S} />
    <path d="M10.5 8.2v4.6l4-2.3z" fill={A.green} stroke={A.green} strokeWidth="1.6" />
  </svg>
)

/** Media Pool — a folder of media. Accent: the tiles inside it. */
const IcPool: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <path d="M2.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" stroke={S} />
    <rect x="6" y="11.5" width="4" height="3.5" rx="0.8" fill={A.cyan} />
    <rect x="11.5" y="11.5" width="4" height="3.5" rx="0.8" fill={A.cyan} opacity="0.55" />
  </svg>
)

/** Prompt Pad — a pad you write on. Accent: the spark. */
const IcPrompt: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <rect x="3.5" y="3" width="17" height="18" rx="2.5" stroke={S} />
    <path d="M7.5 8.5h6M7.5 12.5h5M7.5 16.5h3.5" stroke={S} />
    <path d="M17 13.2l.85 1.95 1.95.85-1.95.85-.85 1.95-.85-1.95-1.95-.85 1.95-.85z" fill={A.yellow} />
  </svg>
)

/** History — a clock running backwards. Accent: the return arrow. */
const IcHistory: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <path d="M3.6 12a8.4 8.4 0 1 0 2.6-6.1" stroke={S} />
    <path d="M12 7.5V12l3 1.8" stroke={S} />
    <path d="M3.2 4v4.2h4.2" stroke={A.coral} />
  </svg>
)

/** Film Look — a strip of film. Accent: the frame with a look on it. */
const IcFilm: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <rect x="3" y="4" width="18" height="16" rx="2" stroke={S} />
    <path d="M7 4v16M17 4v16M3 8.5h4M3 12h4M3 15.5h4M17 8.5h4M17 12h4M17 15.5h4" stroke={S} strokeWidth="1.4" />
    <rect x="9.5" y="8.5" width="5" height="7" rx="0.8" fill={A.yellow} />
  </svg>
)

/** Project cabinet — a chest of drawers. Accent: the pulls. */
const IcCabinet: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <rect x="4.5" y="3.5" width="15" height="17" rx="1.6" stroke={S} />
    <path d="M4.5 9.2h15M4.5 14.8h15" stroke={S} />
    <path d="M10 6.4h4M10 12h4M10 17.6h4" stroke={A.coral} />
  </svg>
)

/** Storyline — a line of points with a branch off it. Accent: the points. */
const IcStoryline: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <path d="M3 15h18M9 15l6-8h6" stroke={S} />
    <circle cx="9" cy="15" r="2.2" fill={A.cyan} stroke="none" />
    <circle cx="16" cy="15" r="2.2" fill={A.cyan} stroke="none" />
    <circle cx="18" cy="7" r="2.2" fill={A.cyan} stroke="none" />
  </svg>
)

/** Browser — every card in the project, to leaf through. A fanned hand of
 *  cards pivoting on its bottom corner: a magnifier said "search the disk",
 *  which is the Media Pool's job, not this one. Accent: the cards behind,
 *  deepening as they come forward, so the fan reads as depth at 26px rather
 *  than three overlapping rectangles. The front card is filled with the tile
 *  colour so it occludes the others cleanly. */
const IcBrowser: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <rect x="6.4" y="2.4" width="9.2" height="13.6" rx="1.8"
          fill={A.violet} opacity="0.32" stroke={A.violet} strokeWidth="1.4"
          transform="rotate(-19 11 17.4)" />
    <rect x="6.4" y="2.4" width="9.2" height="13.6" rx="1.8"
          fill={A.violet} opacity="0.62" stroke={A.violet} strokeWidth="1.4"
          transform="rotate(19 11 17.4)" />
    <rect x="6.4" y="2.4" width="9.2" height="13.6" rx="1.8" fill="#000" stroke={S} />
    {/* The glass on top — the fan says "cards", the lens says "find one". */}
    <circle cx="16.4" cy="15.2" r="4.9" fill="#000" fillOpacity="0.5" stroke={S} />
    <path d="M19.95 18.75L22.3 21.1" stroke={S} strokeWidth="2.4" />
  </svg>
)

/** Effects — an effect card as it sits on the canvas: a 5:7 playing card,
 *  its effect up top and its values below. Accent: the spark, which is
 *  the effect. Opens the palette (EffectPalette) rather than adding one
 *  card, since which effect is the whole choice. */
const IcEffects: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <rect x="5.6" y="3" width="12.8" height="18" rx="2.4" stroke={S} />
    <path d="M12 5.3l.95 2.35 2.35.95-2.35.95-.95 2.35-.95-2.35-2.35-.95 2.35-.95z" fill={A.pink} />
    <path d="M8.6 14.6h6.8M8.6 17.4h4" stroke={S} />
  </svg>
)

// ── New: one glyph per level ──
//
// A plus on a plain square reads as "add anything" — a file, an image, some
// media. This button does something much narrower, and the shape is what says
// so: the outline is the PROPORTION of the thing you are about to make, so the
// icon changes as you zoom the way the button's meaning does.
//
//   card  — portrait, a card standing up
//   block — a wide short bar, the way a clip sits on a timeline
//   node  — 16:9, the frame an image or shot lives in

// ONE plus, shared by all three, always dead centre. Drawing it per-icon gave
// three different sizes, and the shapes were then too small to hold it — the
// plus collided with the outline on every level. Sizing rule, in viewBox
// units: the plus reaches 2.2 from centre and its 2.0 stroke adds 1.0 of cap,
// so it occupies 3.2. The outline's 2.0 stroke eats 1.0 inward. So the shape's
// half-extent must be at least 3.2 + 1.0 + a gap. Every shape below keeps its
// tight axis at half-extent 5.4, which leaves a 1.2 gap on the closest side.
const PLUS_REACH = 2.2
const Plus = () => (
  <path
    d={`M12 ${12 - PLUS_REACH}v${PLUS_REACH * 2}M${12 - PLUS_REACH} 12h${PLUS_REACH * 2}`}
    stroke={A.green}
    strokeWidth="2"
  />
)

/** New card — portrait, a card standing up. Tight axis is the width. */
const IcNewCard: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <rect x="6" y="2" width="12" height="20" rx="2.4" stroke={S} />
    <Plus />
  </svg>
)

/** New block — a clip on the timeline. Runs edge to edge, which is what
 *  separates it from the inset 16:9 frame at a glance. */
const IcNewBlock: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <rect x="0.9" y="6.6" width="22.2" height="10.8" rx="2.4" stroke={S} />
    <Plus />
  </svg>
)

/** New node — a true 16:9 frame (19.2 x 10.8), inset from the edges. */
const IcNewNode: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <rect x="2.4" y="6.6" width="19.2" height="10.8" rx="2.4" stroke={S} />
    <Plus />
  </svg>
)

const IconButton: React.FC<{
  Icon: React.FC<SvgProps>
  title: string
  onClick: () => void
  /** Lit while what it opens is open (the Effects palette). A toggle only;
   *  plain create buttons leave it out. */
  active?: boolean
}> = ({ Icon, title, onClick, active }) => {
  const [hover, setHover] = React.useState(false)
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-pressed={active}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        width: TILE, height: TILE,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        // Lit (open) is the toolbar Cards toggle's pair; it wins over hover.
        background: active ? 'rgba(120,170,255,0.22)' : hover ? 'rgba(120,170,255,0.16)' : 'rgba(255,255,255,0.035)',
        border: `1px solid ${active ? 'rgba(120,170,255,0.5)' : hover ? 'rgba(150,200,255,0.42)' : 'rgba(255,255,255,0.07)'}`,
        borderRadius: 12,
        cursor: 'pointer',
        padding: 0,
        flexShrink: 0,
        transition: 'background 0.12s, border-color 0.12s',
      }}
    >
      <span style={{ pointerEvents: 'none', display: 'flex' }}>
        <Icon size={GLYPH} />
      </span>
    </button>
  )
}

export const TopIconBar: React.FC = () => {
  // The only thing this bar needs from the camera: which level "new" means.
  // Same level LayerRouter is showing (zoomZonesStore).
  const zone = useZoomZone()
  const newLabel =
    zone === 'card' ? 'New card'
    : zone === 'block' ? 'New block'
    : 'New node'
  // The glyph's PROPORTION is the message — see the note above the three.
  const IcNew =
    zone === 'card' ? IcNewCard
    : zone === 'block' ? IcNewBlock
    : IcNewNode

  const onNew = () => {
    if (zone === 'board') {
      // At board zoom the atomic thing on the canvas is a node, not a whole
      // board — making a card here would drop something far bigger than what
      // you are looking at.
      addFreeNodeCentered('note')
      return
    }
    createCardOrBoardAt()
  }

  // The Effects palette. Its own memoised component: this bar re-renders on
  // every zoom tick, the palette has no reason to.
  const [fxOpen, setFxOpen] = React.useState(false)
  const cabinetsOn = useCabinetUi(s => s.enabled)
  const fxBtnRef = React.useRef<HTMLDivElement>(null)
  const closeFx = React.useCallback(() => setFxOpen(false), [])

  return (
    <div
      style={{
        // Fixed and centred: floats over the toolbar instead of taking a row.
        // Out of flow, so the canvas keeps its full height.
        position: 'fixed',
        top: 0,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '4px 10px',
        background: '#000',
        border: '1px solid rgba(255,255,255,0.07)',
        borderTop: 'none',
        borderRadius: '0 0 14px 14px',
        boxShadow: '0 6px 20px rgba(0,0,0,0.55)',
        zIndex: 700,
      }}
    >
      <IconButton
        Icon={IcViewer}
        title="Viewer — a window for models, video and images"
        onClick={() => { addViewerCentered() }}
      />
      <IconButton
        Icon={IcPool}
        title="Media Pool — a folder on disk"
        onClick={() => addFreeNodeCentered('pool')}
      />
      <IconButton
        Icon={IcPrompt}
        title="Prompt Pad"
        onClick={() => addFreeNodeCentered('prompt')}
      />
      <IconButton
        Icon={IcHistory}
        title="History"
        onClick={() => addFreeNodeCentered('history')}
      />
      <IconButton
        Icon={IcBrowser}
        title="Card Browser — leaf through every card in the project"
        onClick={() => addBrowserNode()}
      />
      <IconButton
        Icon={IcFilm}
        title="Film Look — every shot of the film and its look"
        onClick={openFilmMixer}
      />
      <IconButton
        Icon={IcStoryline}
        title="Storyline — points on lines that branch; drag out from the point"
        onClick={() => createStorylineAt()}
      />
      {cabinetsOn && (
        <IconButton
          Icon={IcCabinet}
          title="Project cabinet — drawers to put cards away in"
          onClick={() => addFreeNodeCentered('cabinet')}
        />
      )}
      {/* A wrapper for the ref: the palette hangs under it, and a press on
          it must not count as "outside" (IconButton forwards no ref). */}
      <div ref={fxBtnRef} style={{ display: 'flex' }}>
        <IconButton
          Icon={IcEffects}
          title="Effects — pick one to add to the selected picture's strip"
          active={fxOpen}
          onClick={() => setFxOpen(o => !o)}
        />
      </div>
      <EffectPalette open={fxOpen} anchorRef={fxBtnRef} onClose={closeFx} />

      <div style={{ width: 1, height: TILE * 0.55, background: 'rgba(255,255,255,0.12)', margin: '0 2px' }} />

      <IconButton Icon={IcNew} title={newLabel} onClick={onNew} />
    </div>
  )
}
