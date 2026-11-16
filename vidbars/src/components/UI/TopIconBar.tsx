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
// Everything here creates something ON THE CANVAS via utils/canvasCreate,
// so a button and the canvas right-click menu can never produce different
// results. A button doesn't drop it in the middle of the view: it picks it
// up, an outline of it follows the mouse, and the next click on the canvas
// sets it down there (utils/placeTool). The button stays lit while you aim;
// Esc or the button again puts it back.

import React from 'react'
import { usePlacing, togglePlacing, type PlaceKind } from '../../utils/placeTool'
import { EffectPalette } from './EffectPalette'
import { PromptCardMenu } from './PromptCardMenu'
import { NewCardPalette } from './NewCardPalette'
import { useZoomZone } from '../../store/zoomZonesStore'
import { useCabinetUi } from '../../utils/cabinet'
import { openFilmMixer, existingFilmMixer } from '../FilmMixer/FilmMixerBody'
import { useNotesUi } from '../../store/notesStore'

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
/** Rough Cut — clips end to end. Accent: the cut between two of them. */
const IcCut: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <rect x="2.5" y="8" width="8" height="8" rx="1.5" stroke={S} />
    <rect x="13.5" y="8" width="8" height="8" rx="1.5" stroke={S} />
    <path d="M12 4.5v15" stroke={A.coral} strokeWidth="2" />
  </svg>
)

const IcFilm: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <rect x="3" y="4" width="18" height="16" rx="2" stroke={S} />
    <path d="M7 4v16M17 4v16M3 8.5h4M3 12h4M3 15.5h4M17 8.5h4M17 12h4M17 15.5h4" stroke={S} strokeWidth="1.4" />
    <rect x="9.5" y="8.5" width="5" height="7" rx="0.8" fill={A.yellow} />
  </svg>
)

/** Loop strip — the run band across the top, cards docked in columns
 *  under it. Accent: the run arrow and the cards. */
const IcLoopStrip: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <rect x="2.5" y="3.5" width="19" height="17" rx="2.2" stroke={S} />
    <path d="M2.5 9.2h19" stroke={S} />
    <path d="M6 6.35h10.5M14.3 4.9l2.4 1.45-2.4 1.45" stroke={A.green} strokeWidth="1.6" />
    <rect x="5.2" y="11.8" width="3.6" height="5.8" rx="0.8" fill={A.green} stroke="none" />
    <rect x="10.2" y="11.8" width="3.6" height="5.8" rx="0.8" fill={A.green} opacity="0.6" stroke="none" />
    <rect x="15.2" y="11.8" width="3.6" height="5.8" rx="0.8" fill={A.green} opacity="0.35" stroke="none" />
  </svg>
)

/** 3D scene — a mat seen in perspective with a cube standing on it.
 *  Accent: the cube. */
const IcScene3d: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <path d="M1.8 21l4.6-7.5h15.8L17.6 21z" stroke={S} />
    <path d="M4.1 17.25h15.8M11.6 13.5L9 21M17 13.5L14.4 21" stroke={S} strokeWidth="1" opacity="0.55" />
    <path d="M8 5.6v6.2l4.3 2.4 4.3-2.4V5.6l-4.3-2.4z" stroke={A.cyan} />
    <path d="M8 5.6l4.3 2.4 4.3-2.4M12.3 8v6.2" stroke={A.cyan} strokeWidth="1.2" />
  </svg>
)

/** State workspace — two icons and the arrow between them. Accent: the lit one. */
const IcStateSpace: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <rect x="2.5" y="4" width="7" height="7" rx="1.6" stroke={A.cyan} />
    <rect x="14.5" y="13" width="7" height="7" rx="1.6" stroke={S} />
    <path d="M9.5 7.5h5.2a3.3 3.3 0 0 1 3.3 3.3V13M16 11l2 2 2-2" stroke={S} strokeWidth="1.2" />
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

/** Attributes — a card's back: its rows side by side with how many cards
 *  share each. Accent: the share bars. */
const IcAttributes: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <rect x="3" y="3.5" width="18" height="17" rx="2.4" stroke={S} />
    <path d="M6.5 8h3.5M6.5 12h3.5M6.5 16h3.5" stroke={S} strokeWidth="1.6" />
    <path d="M12.5 8h5M12.5 12h3.4M12.5 16h1.8" stroke={A.violet} strokeWidth="2.4" />
  </svg>
)

/** Card Prompts — a prompt pad fed by a card. Accent: the card's words. */
const IcCardPrompt: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <rect x="9" y="3" width="12.5" height="15" rx="2.2" stroke={S} />
    <path d="M12 7.5h6.5M12 11h4.5" stroke={S} strokeWidth="1.6" />
    <rect x="2.5" y="9.5" width="7.5" height="11" rx="1.4" fill="#000" stroke={A.cyan} strokeWidth="1.6" />
    <path d="M4.6 13.2h3.3M4.6 16.2h2.4" stroke={A.cyan} strokeWidth="1.5" />
  </svg>
)

/** Prompt card — a card whose back is rows of words. Opens a menu
 *  (PromptCardMenu): blank, a ready-made one, or all of them as a deck. */
const IcPromptCard: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <rect x="5.6" y="3" width="12.8" height="18" rx="2.4" stroke={S} />
    <path d="M8.6 7.2h6.8" stroke={A.cyan} strokeWidth="2.2" />
    <rect x="8.2" y="10.6" width="3.6" height="2.6" rx="1.3" stroke={A.cyan} strokeWidth="1.3" />
    <rect x="12.6" y="10.6" width="3.2" height="2.6" rx="1.3" stroke={S} strokeWidth="1.3" />
    <rect x="8.2" y="15" width="4.6" height="2.6" rx="1.3" stroke={S} strokeWidth="1.3" />
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

/** Notes & 3D tools — a curve with an arrowhead over a pinned label.
 *  Accent: the arrow and the pin. */
const IcNotes: React.FC<SvgProps> = ({ size }) => (
  <svg {...svgBase(size)}>
    <path d="M3.5 19.5C6 11 11 9 17.5 9.5" stroke={S} />
    <path d="M15 6.5l3 3-3.2 2.8" stroke={A.cyan} />
    <circle cx="7" cy="7" r="2.3" fill={A.yellow} stroke="none" />
    <path d="M13 16.5h7.5M13 19.5h5" stroke={S} strokeWidth="1.6" />
  </svg>
)

// ── Button order ──
// The bar's buttons by id, in the order they ship in. The saved order wins;
// any button added later that isn't in it yet goes in after the one it
// follows here.
type BarId =
  | 'viewer' | 'pool' | 'prompt' | 'promptCards' | 'history' | 'browser' | 'attributes' | 'filmMixer'
  | 'roughCut' | 'storyline' | 'cabinet' | 'loopStrip' | 'scene3d' | 'stateSpace' | 'effects' | 'promptCard' | 'notes' | 'new'
const DEFAULT_ORDER: BarId[] = [
  'viewer', 'pool', 'prompt', 'promptCards', 'history', 'browser', 'attributes', 'filmMixer',
  'roughCut', 'storyline', 'cabinet', 'loopStrip', 'scene3d', 'stateSpace', 'effects', 'promptCard', 'notes', 'new',
]
const ORDER_KEY = 'vidbars.topIconBar.order'

function loadOrder(): BarId[] {
  let saved: unknown = null
  try { saved = JSON.parse(localStorage.getItem(ORDER_KEY) || 'null') } catch { /* private window */ }
  if (!Array.isArray(saved)) return DEFAULT_ORDER.slice()
  const out = saved.filter((x, i): x is BarId =>
    DEFAULT_ORDER.includes(x as BarId) && saved.indexOf(x) === i)
  DEFAULT_ORDER.forEach((id, i) => {
    if (out.includes(id)) return
    // Orders saved before New could move have no 'new': it was at the end.
    if (id === 'new') { out.push(id); return }
    const prev = DEFAULT_ORDER.slice(0, i).reverse().find(p => out.includes(p))
    out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, id)
  })
  return out
}

function saveOrder(order: BarId[]) {
  try { localStorage.setItem(ORDER_KEY, JSON.stringify(order)) } catch { /* private window */ }
}

const IconButton: React.FC<{
  Icon: React.FC<SvgProps>
  title: string
  onClick: () => void
  /** Lit while what it opens is open (the Effects palette), or while the
   *  mouse is carrying what it places (utils/placeTool). */
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

  // At board zoom "new" places a note, not a whole board — a card there
  // would be far bigger than what you are looking at (utils/placeTool).

  // What the mouse is carrying, so its button stays lit while you aim.
  const placing = usePlacing(s => s.kind)
  const notesOpen = useNotesUi(s => s.open)
  const place = (kind: PlaceKind) => ({ onClick: () => togglePlacing(kind), active: placing === kind })

  // The Effects palette. Its own memoised component: this bar re-renders on
  // every zoom tick, the palette has no reason to.
  const [fxOpen, setFxOpen] = React.useState(false)
  const cabinetsOn = useCabinetUi(s => s.enabled)
  const fxBtnRef = React.useRef<HTMLDivElement>(null)
  const closeFx = React.useCallback(() => setFxOpen(false), [])
  // The Prompt card menu, the same way.
  const [pcOpen, setPcOpen] = React.useState(false)
  const pcBtnRef = React.useRef<HTMLDivElement>(null)
  const closePc = React.useCallback(() => setPcOpen(false), [])
  // The New card palette, the same way: which kind of card is the choice.
  // At board zoom New places a note, as it did.
  const [ncOpen, setNcOpen] = React.useState(false)
  const ncBtnRef = React.useRef<HTMLDivElement>(null)
  const closeNc = React.useCallback(() => setNcOpen(false), [])

  // Every button, by id. The ORDER they sit in is Brian's: drag one along
  // the bar to move it, and the order is saved (localStorage) so it is the
  // same after a reload. Every button moves, "New" included.
  const buttons: Record<BarId, React.ReactNode> = {
    viewer: <IconButton Icon={IcViewer} title="Viewer — a window for models, video and images" {...place('viewer')} />,
    pool: <IconButton Icon={IcPool} title="Media Pool — a folder on disk" {...place('pool')} />,
    prompt: <IconButton Icon={IcPrompt} title="Prompt Pad" {...place('prompt')} />,
    promptCards: <IconButton Icon={IcCardPrompt} title="Card Prompts — a Prompt Pad whose words come from the backs of the cards docked on it" {...place('promptCards')} />,
    history: <IconButton Icon={IcHistory} title="History" {...place('history')} />,
    browser: <IconButton Icon={IcBrowser} title="Card Browser — leaf through every card in the project" {...place('browser')} />,
    attributes: <IconButton Icon={IcAttributes} title="Attributes — the backs of the cards docked on it, side by side: which details they share, the outliers, every value" {...place('attributes')} />,
    filmMixer: (
      <IconButton
        Icon={IcFilm}
        title="Film Look — every shot of the film and its look"
        // Only ever one mixer: with one on the canvas already, the button
        // takes the camera to it instead.
        onClick={() => { if (existingFilmMixer()) openFilmMixer(); else togglePlacing('filmMixer') }}
        active={placing === 'filmMixer'}
      />
    ),
    roughCut: <IconButton Icon={IcCut} title="Rough Cut — put clips in order and trim them" {...place('roughCut')} />,
    storyline: <IconButton Icon={IcStoryline} title="Storyline — points on lines that branch; drag out from the point" {...place('storyline')} />,
    cabinet: <IconButton Icon={IcCabinet} title="Project cabinet — drawers to put cards away in" {...place('cabinet')} />,
    loopStrip: <IconButton Icon={IcLoopStrip} title="Loop strip — drop cards in and run effects over them" {...place('loopStrip')} />,
    scene3d: <IconButton Icon={IcScene3d} title="3D set — a mat that becomes a 3D workspace: dock model cards along it and lay their models out inside. Right-click it to fold it into a card" {...place('area')} />,
    stateSpace: <IconButton Icon={IcStateSpace} title="States — a workspace for states: drag cards in to make icons, draw lines between them, light the one that is now" {...place('stateSpace')} />,
    // The Effects wrapper carries fxBtnRef: the palette hangs under it, and
    // a press on it must not count as "outside" (IconButton forwards no ref).
    effects: (
      <IconButton
        Icon={IcEffects}
        title="Effects — pick a card up, then click where it goes: the canvas, or between two cards on a loop strip"
        active={fxOpen || placing === 'effect'}
        onClick={() => setFxOpen(o => !o)}
      />
    ),
    promptCard: (
      <IconButton
        Icon={IcPromptCard}
        title="Prompt card — a card of words for Card Prompts: blank, ready-made, or all the ready-made ones as a deck"
        active={pcOpen}
        onClick={() => setPcOpen(o => !o)}
      />
    ),
    // The Notes & 3D tools panel (components/Notes/NotesPanel): lit while out.
    notes: <IconButton Icon={IcNotes} title="Notes & 3D tools — curves, arrows, drawing on models, pins, 3D sets" active={notesOpen} onClick={() => useNotesUi.setState(s => ({ open: !s.open, tool: s.open ? null : s.tool }))} />,
    new: (
      <IconButton
        Icon={IcNew}
        title={newLabel}
        active={ncOpen || placing === 'new'}
        // Lit and carrying one: the button puts it back, as every button does.
        onClick={() => { if (zone === 'board' || placing === 'new') { setNcOpen(false); togglePlacing('new') } else setNcOpen(o => !o) }}
      />
    ),
  }

  const [order, setOrder] = React.useState<BarId[]>(loadOrder)
  const shown = order.filter(id => id !== 'cabinet' || cabinetsOn)

  // ── Drag to reorder ──
  // Press and move a few px sideways: the icon lifts and follows the mouse,
  // the others slide aside to show where it will land. A press that doesn't
  // move is an ordinary click.
  const [drag, setDrag] = React.useState<{ id: BarId; from: number; to: number; dx: number } | null>(null)
  const dragRef = React.useRef<{ id: BarId; x0: number; from: number; centers: number[]; live: boolean; to: number } | null>(null)
  const justDragged = React.useRef(false)
  // One frame with no slide on drop, so the icons don't animate back out of
  // the slots they've just been moved into.
  const [settling, setSettling] = React.useState(false)
  const STEP = TILE + 8 // tile + the bar's gap

  const onGrab = (e: React.PointerEvent<HTMLDivElement>, id: BarId) => {
    if (e.button !== 0) return
    const wrap = e.currentTarget
    const row = Array.from(wrap.parentElement!.querySelectorAll<HTMLElement>('[data-top-icon]'))
    const centers = row.map(el => { const r = el.getBoundingClientRect(); return r.left + r.width / 2 })
    dragRef.current = { id, x0: e.clientX, from: row.indexOf(wrap), centers, live: false, to: row.indexOf(wrap) }
    const move = (ev: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      const dx = ev.clientX - d.x0
      if (!d.live) {
        if (Math.abs(dx) < 6) return
        d.live = true
      }
      // Clamp to the ends of the row so it can't wander off the bar.
      const min = d.centers[0] - d.centers[d.from]
      const max = d.centers[d.centers.length - 1] - d.centers[d.from]
      const cdx = Math.max(min, Math.min(max, dx))
      const x = d.centers[d.from] + cdx
      let to = 0, best = Infinity
      d.centers.forEach((c, i) => { const dd = Math.abs(c - x); if (dd < best) { best = dd; to = i } })
      d.to = to
      setDrag({ id: d.id, from: d.from, to, dx: cdx })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      const d = dragRef.current
      dragRef.current = null
      if (!d?.live) { setDrag(null); return }
      justDragged.current = true
      setTimeout(() => { justDragged.current = false }, 0)
      setSettling(true)
      requestAnimationFrame(() => requestAnimationFrame(() => setSettling(false)))
      setDrag(null)
      if (d.from === d.to) return
      const vis = order.filter(x => x !== 'cabinet' || cabinetsOn)
      const next = vis.slice()
      const [m] = next.splice(d.from, 1)
      next.splice(d.to, 0, m)
      // Put a hidden cabinet back where it was.
      const ci = order.indexOf('cabinet')
      if (!cabinetsOn && ci >= 0) next.splice(Math.min(ci, next.length), 0, 'cabinet')
      saveOrder(next)
      setOrder(next)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  // The click that ends a drag is not a press of the button.
  const swallowClickAfterDrag = (e: React.MouseEvent) => {
    if (justDragged.current) { e.stopPropagation(); e.preventDefault() }
  }

  const shiftFor = (i: number) => {
    if (!drag) return 0
    if (i === drag.from) return drag.dx
    if (drag.from < drag.to && i > drag.from && i <= drag.to) return -STEP
    if (drag.from > drag.to && i < drag.from && i >= drag.to) return STEP
    return 0
  }

  return (
    <div
      data-top-icon-bar=""
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
      {shown.map((id, i) => (
        <React.Fragment key={id}>
        {id === 'new' && i === shown.length - 1 && (
          <div style={{ width: 1, height: TILE * 0.55, background: 'rgba(255,255,255,0.12)', margin: '0 2px' }} />
        )}
        <div
          ref={id === 'effects' ? fxBtnRef : id === 'promptCard' ? pcBtnRef : id === 'new' ? ncBtnRef : undefined}
          data-top-icon={id}
          onPointerDown={e => onGrab(e, id)}
          onClickCapture={swallowClickAfterDrag}
          style={{
            display: 'flex',
            transform: `translateX(${shiftFor(i)}px)`,
            transition: drag?.id === id || settling ? 'none' : 'transform 0.15s',
            position: 'relative',
            zIndex: drag?.id === id ? 1 : 0,
            touchAction: 'none',
          }}
        >
          {buttons[id]}
        </div>
        </React.Fragment>
      ))}
      <EffectPalette open={fxOpen} anchorRef={fxBtnRef} onClose={closeFx} />
      <PromptCardMenu open={pcOpen} anchorRef={pcBtnRef} onClose={closePc} />
      <NewCardPalette open={ncOpen} anchorRef={ncBtnRef} onClose={closeNc} />
    </div>
  )
}
