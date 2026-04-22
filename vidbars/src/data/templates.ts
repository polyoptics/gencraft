import type { Bar } from '../types/bar'

function b(
  id: string,
  parentId: string | null,
  rowIndex: number,
  x: number,
  width: number,
  children: string[],
  overrides: Partial<Bar> = {},
): Bar {
  return {
    id,
    parentId,
    rowIndex,
    x,
    width,
    height: Math.max(60, Math.round(width * 9 / 16)),  // 16:9 per block
    name: 'Untitled',
    subtitle: '',
    icon: null,
    color: '#5b8dd9',
    children,
    content: { text: '', images: [], media: [], mentions: [] },
    ...overrides,
  }
}

export interface TemplateData {
  id: string
  label: string
  projectName: string
  bars: Record<string, Bar>
  rootIds: string[]
  canvasWidth: number
  zoom: number
}

// ── Color palette from the reference images ──
const BLUE    = '#5b8dd9'   // default / structure
const TEAL    = '#2aa198'   // scenes / middle layer
const ORANGE  = '#e8943a'   // flashback / alt
const LTBLUE  = '#7baed4'   // title / header strips

export const TEMPLATES: TemplateData[] = [
  // ── Blank ──────────────────────────────────────────────────────────────
  {
    id: 'blank',
    label: 'Blank',
    projectName: 'storyMap',
    bars: { root: b('root', null, 0, 0, 480, []) },
    rootIds: ['root'],
    canvasWidth: 520,
    zoom: 1,
  },

  // ── storyMap ── hierarchy: one board, layers computed from bar tree depth
  //
  // Layer 0 (outermost):  | Title | ACT 1                       |
  // Layer 1:              | Title | DROP                         |
  // Layer 2:              | Title | The Arrival    | FlashBack   |
  // Layer 3:              | Title | Maridian | awakening | FlashBack |
  //
  // "Title" has no children → carries forward at every level.
  // "FlashBack" has no children → carries forward from layer 2 to 3.
  {
    id: 'storyMap',
    label: 'storyMap',
    projectName: 'storyMap',
    bars: {
      // ── Layer 0: Title + ACT 1 ──
      title: b('title', null, 0, 0, 200, [], {
        name: 'Title', color: LTBLUE, subtitle: 'intro',
      }),
      act1: b('act1', null, 0, 210, 800, ['drop'], {
        name: 'ACT 1', color: BLUE, subtitle: 'main act',
      }),

      // ── Layer 1: DROP (child of ACT 1) ──
      drop: b('drop', 'act1', 1, 210, 800, ['arrival', 'flashback'], {
        name: 'DROP', color: BLUE, subtitle: 'placeholder',
      }),

      // ── Layer 2: The Arrival + FlashBack (children of DROP) ──
      arrival: b('arrival', 'drop', 2, 210, 500, ['maridian', 'awakening'], {
        name: 'The Arrival', color: TEAL, subtitle: 'scene',
      }),
      flashback: b('flashback', 'drop', 2, 720, 290, [], {
        name: 'FlashBack', color: ORANGE, subtitle: 'alt timeline',
      }),

      // ── Layer 3: Maridian + awakening (children of The Arrival) ──
      maridian: b('maridian', 'arrival', 3, 210, 250, [], {
        name: 'Maridian', color: TEAL, subtitle: 'location',
      }),
      awakening: b('awakening', 'arrival', 3, 470, 240, [], {
        name: 'awakening', color: TEAL, subtitle: 'scene',
      }),
    },
    rootIds: ['title', 'act1'],
    canvasWidth: 1050,
    zoom: 0.85,
  },

  // ── vidBarDemo1 ── generic branching tree ──────────────────────────────
  {
    id: 'vidBarDemo1',
    label: 'Branching Tree',
    projectName: 'storyMap',
    bars: {
      r0a: b('r0a', null, 0, 0,    320, ['r1a'], { name: 'FIRST FRAME' }),
      r0b: b('r0b', null, 0, 330,  220, ['r1b'], { name: 'Key 1' }),
      r0c: b('r0c', null, 0, 560,  220, ['r1c'], { name: 'Key 2' }),
      r0d: b('r0d', null, 0, 790,  220, [],       { name: 'Key 3' }),
      r0e: b('r0e', null, 0, 1020, 320, [],        { name: 'LAST FRAME' }),

      r1a: b('r1a', 'r0a', 1, 0,   320, ['r2a1', 'r2a2'], { name: 'Intro Detail' }),
      r1b: b('r1b', 'r0b', 1, 330, 220, [],                { name: 'Key 1 Detail' }),
      r1c: b('r1c', 'r0c', 1, 560, 220, [],                { name: 'Key 2 Detail' }),

      r2a1: b('r2a1', 'r1a', 2, 0,   155, [], { name: 'Shot A' }),
      r2a2: b('r2a2', 'r1a', 2, 165, 155, [], { name: 'Shot B' }),
    },
    rootIds: ['r0a', 'r0b', 'r0c', 'r0d', 'r0e'],
    canvasWidth: 1380,
    zoom: 0.85,
  },
]
