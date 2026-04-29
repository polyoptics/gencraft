/**
 * Trailer scaffolds — multi-block "skeletons" the user (or an agent) drops onto
 * the canvas as a starting point. Each scaffold is one ProjectGroup containing
 * several boards (blocks), where each block is a labeled story-beat placeholder
 * the user can later fill in.
 *
 * Loading is done via `instantiateScaffold(id, originY)` which generates fresh
 * UUIDs for the group, every board, and every bar so the scaffold can be added
 * to the canvas as many times as desired.
 */
import type { Bar } from '../types/bar'
import type { BoardData, ProjectGroup, BoardLayerData } from '../store/boardsStore'

// Block layout — each block is INIT_W wide; we leave a small gap between them.
const BLOCK_W = 480
const BLOCK_H = 270
const BLOCK_GAP = 40
const BLOCK_STRIDE = BLOCK_W + BLOCK_GAP   // 520

// Default empty layers for each block board
const EMPTY_LAYERS: BoardLayerData = {
  card: { heroImage: null, summary: '', text: '' },
  block: { thumbnail: null, label: '', text: '' },
}

export interface ScaffoldBlock {
  /** Big label shown on the block at block-zoom (also written to projectName) */
  label: string
  /** Optional sub-label / role (e.g. "scene", "shot") */
  subtitle?: string
  /** Optional accent color override (hex). Defaults to scaffold color. */
  color?: string
}

export interface ScaffoldData {
  id: string
  name: string                     // shown in the menu
  description: string              // short subtitle
  color: string                    // group color (and default block accent)
  /** Optional intro line shown on the card-zoom face. */
  cardSummary?: string
  blocks: ScaffoldBlock[]
}

// ── Color palette (a few distinct theme colors for the 4 scaffolds) ──
const C_BLUE   = '#5b8dd9'  // Three-Act: classic / structural
const C_GOLD   = '#d9a45b'  // Classic Trailer: warm cinematic
const C_RED    = '#d9695b'  // Pulse Trailer: high-energy action
const C_PURPLE = '#8d6bd9'  // Mystery Reveal: enigmatic

export const SCAFFOLDS: ScaffoldData[] = [
  // ── 1. Three-Act ─────────────────────────────────────────────
  {
    id: 'scaffold-three-act',
    name: 'Three-Act Trailer',
    description: 'Setup → Confrontation → Resolution',
    color: C_BLUE,
    cardSummary: 'Three-act structure',
    blocks: [
      { label: 'SETUP',         subtitle: 'who & where' },
      { label: 'CONFRONTATION', subtitle: 'the problem' },
      { label: 'RESOLUTION',    subtitle: 'payoff / tag' },
    ],
  },

  // ── 2. Classic Trailer (matches the porcelain-sea reference) ──
  {
    id: 'scaffold-classic-trailer',
    name: 'Classic Trailer',
    description: 'Cold Open → Intro → Escalation → Climax → Tag',
    color: C_GOLD,
    cardSummary: 'Five-beat trailer arc',
    blocks: [
      { label: 'COLD OPEN',         subtitle: 'hook' },
      { label: 'INTRODUCTION',      subtitle: 'characters & world' },
      { label: 'ESCALATION',        subtitle: 'rising stakes' },
      { label: 'CLIMAX',            subtitle: 'peak moment' },
      { label: 'CREDITS / TEASER',  subtitle: 'title card · button' },
    ],
  },

  // ── 3. Pulse / Action ─────────────────────────────────────────
  {
    id: 'scaffold-pulse',
    name: 'Pulse Trailer',
    description: 'Rapid-fire jolts with breath beats',
    color: C_RED,
    cardSummary: 'High-tempo action edit',
    blocks: [
      { label: 'WORLD',       subtitle: 'establish' },
      { label: 'JOLT',        subtitle: 'first impact' },
      { label: 'PULL BACK',   subtitle: 'breath beat' },
      { label: 'BIGGER JOLT', subtitle: 'second impact' },
      { label: 'OPEN UP',     subtitle: 'spectacle montage' },
      { label: 'BUTTON',      subtitle: 'logo / tag' },
    ],
  },

  // ── 4. Mystery Reveal ────────────────────────────────────────
  {
    id: 'scaffold-mystery',
    name: 'Mystery Reveal',
    description: 'Tease → Breadcrumb → Rabbit Hole → Reveal → Cliffhanger',
    color: C_PURPLE,
    cardSummary: 'Slow-burn mystery arc',
    blocks: [
      { label: 'TEASE',        subtitle: 'something is off' },
      { label: 'BREADCRUMB',   subtitle: 'first clue' },
      { label: 'RABBIT HOLE',  subtitle: 'investigation' },
      { label: 'REVELATION',   subtitle: 'the truth' },
      { label: 'CLIFFHANGER',  subtitle: 'next question' },
    ],
  },
]

/** Result of instantiating a scaffold — caller writes these into the stores. */
export interface ScaffoldInstance {
  group: ProjectGroup
  boards: BoardData[]
}

/**
 * Build a fresh instance of the scaffold with new UUIDs everywhere.
 *  - originY: where the new group's top-left lands in canvas space
 *  - originX: optional X offset (default 0)
 *
 * Returns the new group + boards. Caller is responsible for inserting them
 * into the boards store (boards map, boardOrder, groups array).
 */
export function instantiateScaffold(
  id: string,
  originY: number,
  originX = 0,
): ScaffoldInstance | null {
  const scaffold = SCAFFOLDS.find(s => s.id === id)
  if (!scaffold) return null

  const groupId = crypto.randomUUID()
  const boards: BoardData[] = []
  const boardIds: string[] = []

  scaffold.blocks.forEach((blk, i) => {
    const boardId = crypto.randomUUID()
    const rootId  = crypto.randomUUID()
    const accent  = blk.color ?? scaffold.color

    const rootBar: Bar = {
      id: rootId,
      parentId: null,
      rowIndex: 0,
      x: 0,
      width: BLOCK_W,
      height: BLOCK_H,
      name: blk.label,
      subtitle: blk.subtitle ?? '',
      icon: null,
      color: accent,
      children: [],
      content: { text: '', images: [], media: [], mentions: [] },
    }

    const board: BoardData = {
      id: boardId,
      projectName: blk.label,           // also the block's fallback display label
      color: accent,
      nleRow: 0,
      nleX: i * BLOCK_STRIDE,
      bars: { [rootId]: rootBar },
      rootIds: [rootId],
      viewerBarId: null,
      selectedIds: [],
      savedCollapsedState: null,
      pristine: true,
      boardScale: 1,
      layers: {
        ...EMPTY_LAYERS,
        block: { ...EMPTY_LAYERS.block, label: blk.label },
      },
    }

    boards.push(board)
    boardIds.push(boardId)
  })

  const group: ProjectGroup = {
    id: groupId,
    name: scaffold.name,
    color: scaffold.color,
    boardIds,
    cardHeroImage: null,
    cardSummary: scaffold.cardSummary ?? '',
    cardText: '',
    cardHeaderText: scaffold.name,
    originX,
    originY,
  }

  return { group, boards }
}
