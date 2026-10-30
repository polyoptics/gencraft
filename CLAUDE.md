# ProjectVidBars

GenAI video creation interface — infinite canvas of recursive semantic "bars" that compose into stories. React + TypeScript + Zustand, Vite dev server.

## Before you start

**Type-check with `npx tsc -b` from `vidbars/`.** A bare `tsc --noEmit` is a
**no-op** here — the root tsconfig is references-only, so it checks nothing and
reports success. `tsc -b` is the only real gate.

Verify UI changes in the browser preview, not by reading the code. Stores are
exposed on `window.__stores` for exactly this. Reaching a store through a
dynamic `import()` gets a **second copy of the module with its own state**,
which reads as "the feature does nothing" when the feature is fine — this has
produced false negatives more than once. Add a store to `main.tsx` instead.

## Invariants

These are the rules that are easy to violate without noticing, because the
wrong thing looks right. Most bugs here have been one of these, often the same
one in several components at once.

### 1. Read the camera through `useCardView()`, never `useCanvasStore` directly

Anything drawn **inside a card** must get pan/zoom from `useCardView()`
(`components/Layers/cardView.tsx`). It returns the live canvas camera normally
and a **frozen** one inside a pinned card. A component that reads
`useCanvasStore(s => s.pan/zoom)` directly will render at the card's abandoned
canvas coordinates the moment that card is pinned. This exact bug has appeared
in CloneDeck, CardOutline, BlockOutline, TetherTab, BlockItem and NLEBlock.

Corollary: every `/zoom` counter-scale (holding chrome at a constant screen
size) must divide by the **card's** camera, or the chrome is mis-sized inside
a pinned card while looking fine on the canvas.

### 2. Blocks and boards render from board ids, not from groups

`BlockLayer.Canvas` and `BoardsCanvas` iterate `boardOrder` — every board in
the project. Filtering the `groups` list scopes **nothing**, because those
loops never read it. Scope by deriving the allowed board-id set (see the
`only?: string[]` prop on `CardLayer.Overlay` / `BlockLayer` / `BoardLayer` /
`BoardsCanvas`, and `pinnedAwayBoards` for the reverse direction).

### 3. Use the right geometry helper — the wrong ones look right

| Want | Use | Do NOT use |
|------|-----|------------|
| A card's face rect | `cardScreenRect()` (CardLayer) — pass `pan {0,0}, zoom 1` for canvas units | `cardVisualRect()` — inflates ±16 units and uses a stale header formula; it is the **clustering/docking** rect |
| A group's block extent | compute it — see the note below | `computeGroupBlockFootprint()` — omits the 57-unit header band and the size overrides |
| A group's board extent | compute it | `jumpToGroup()`'s bounds — never walks child bars |

Where a helper is known-wrong, prefer **measuring the rendered DOM and dividing
out the camera it was drawn with**: that yields canvas units that cannot
disagree with the render, and is scale-invariant so it cannot oscillate.

### 4. Two counter-scaling idioms — match the surrounding layer

- **World space** (blocks, bars, and their chrome): the element lives inside
  the canvas transform, so divide every dimension by the camera's zoom.
- **Screen space** (cards and their chrome): wrap in
  `transform: scale(ratio)` with children at **natural sizes**. See
  `PrimaryChipRail`. Do not invent clamp arithmetic — copy this.

### 5. Header extension must match everywhere

Cards extend upward behind `NLETimelineHeader` by `headerExtend(zoom)` —
always call the exported function, never re-derive the formula. It must agree
across `GroupCard`, `StackedDeckCard`, `FannedDeckOverlay`, `CardOutline`,
`cardScreenRect()` and `DeckAffordance`. Note it is a **screen-px** quantity,
so in canvas units it varies with zoom: `headerExtend(z) / z`.

### 6. Generated media must be `data:` URLs

Blob URLs are unusable in this runtime — bytes above ~256 B are unreadable
(FileReader, `arrayBuffer()`, `fetch().blob()`, `createImageBitmap` all fail;
`<img>` decodes 0×0). FBX embedded textures are patched to data URLs in
`three/fbxDataTextures.ts` for this reason.

### 7. Persist migrations

Bump `version` and write its `migrate` branch **in one edit**. Doing it across
two edits lets HMR reload in between and strand the data.

## Architecture

### Zoom layers
Three rendering layers switch on zoom (`LayerRouter.tsx`):
- **Card** (≤ 0.18) — one composite card per project group
- **Block** (0.18–0.30) — board-level blocks with NLE timeline headers
- **Board** (> 0.30) — full bar editing: split, resize, content

`LayerRouter` mounts exactly **one** at a time. Two consequences: a card's drop
target and a bar's drop target are never on screen together (a drag can still
cross levels, because zooming mid-gesture does not interrupt the pointer
stream), and anything needed at all zooms must mount outside the router — as
`PinLayer` does.

### Data model
- **Bar** — atomic named/colored rect; recursive tree via splits. Unique only
  **within** a board.
- **BoardData** — a tree of bars, belongs to a project group.
- **ProjectGroup** — groups boards into one card. `originX/Y`, `color`, card
  text/styles, hero image, deck state, and `pin`/`home`/`pinnedLayer`.
- **Deck** — touching cards; states `open` | `stacked` | `fanned`.
- **LinkRef** — what a link points at: card, block or element
  (`utils/linkTargets.ts`).

### Rendering model
- **Canvas layer**: `transform: scale(zoom)` world — bars and blocks.
- **Overlay layer**: screen-space pixels — cards, headers, affordances, at
  `pan + canvasValue * zoom`.

### Pinning — a pin is a FRAME
Pinning a card is *the same rendering handed a different camera*
(`cardView.tsx`). `PinnedCardView` solves `pan = anchor − origin × scale` so
`pan + origin × zoom` lands on the anchor.

The pin defines a **fixed box on screen**. The 1/2/3 level buttons choose what
is drawn *inside* it and must never move or resize it — content larger than
the frame is scaled down into it. `setPinnedLayer` therefore sets **only** the
layer; it must not touch `pin.scale`.

A pinned card has **left the canvas**: it must not render there, must not be a
collision obstacle at its old footprint (`canvasObstacleGroups()`), and shows
only a dotted outline where it was. `originX/originY` stay live world
coordinates while pinned — that is what makes unpin seamless, and also what
makes stale-footprint bugs so easy to write.

### Linking
The drop **target owns the reference**: dropping A onto B means B references A.
Storage is split for compatibility — `linkedGroupIds` still holds card→card
links (many consumers read it directly); `linkedRefs` holds block and element
referents on groups, boards and bars. Read the union via `ownerRefs()`.

The drag pipeline is entirely screen-space (`clientX/Y` →
`document.elementsFromPoint` → `[data-link-drop]`), so it crosses the pin
boundary for free. **The topmost hit wins** — do not skip past the source and
keep scanning, or a drop falls through onto whatever lies behind it.

## State

| Store | Holds |
|-------|-------|
| `boardsStore.ts` | All bar/board/group data, decks, pinning, linking |
| `canvasStore.ts` | Pan, zoom, zoneLineY, focusedBoardId, selections |
| `freeNodeStore.ts` | Independent text/image/list nodes on canvas |
| `viewport3dStore.ts` | Viewer windows and their active item |
| `linkDragStore.ts` / `linkingStore.ts` | In-flight link drag; clone expansion |
| `poolStore.ts` | Media Pool listings |
| `nleViewerStore.ts` | NLE viewer open/close per group |
| `magnetPreviewStore.ts` / `pinTravelStore.ts` | Transient affordances |
| `historyStore.ts` / `textVersionStore.ts` | History lens, text versions |
| `userTemplateStore.ts` | Saved templates — **do not mutate; user's work** |
| `undoCoordinator.ts` | Undo/redo checkpoints |

## Key files

| File | Purpose |
|------|---------|
| `components/Layers/LayerRouter.tsx` | Zoom threshold switching |
| `components/Layers/cardView.tsx` | **The camera seam** — `useCardView`, `PinnedCardView` |
| `components/Layers/CardLayer.tsx` | Card zoom — GroupCard, decks, `cardScreenRect`, CardLinkingLayer |
| `components/Layers/BlockLayer.tsx` | Block zoom — BlockItem |
| `components/Layers/BoardLayer.tsx` | Bar editing zoom |
| `components/Layers/CardOutline.tsx`, `BlockOutline.tsx` | Shape outlines at other zooms |
| `components/Canvas/InfiniteCanvas.tsx` | Pan/zoom container, drops, hit-testing |
| `components/Canvas/PinLayer.tsx` | Screen-space host for everything pinned; `PinnedLevel` fit |
| `components/Canvas/PinnedCardBar.tsx` | 1/2/3 level bar + corner resize grip |
| `components/NLE/NLETimelineHeader.tsx` | Timeline header; `headerExtend`, `overviewScale` |
| `components/NLE/NLEBlock.tsx` | Bar rendering at board zoom |
| `components/Linking/LinkChipRail.tsx` | Reference chips for blocks and elements |
| `components/Linking/PrimaryChipRail.tsx` | Card reference chips — **the scale-wrapper reference** |
| `components/Viewport3D/` | 3D/content Viewer windows, GL host |
| `components/Rolodex/CardRolodex.tsx` | Card browser panel |
| `utils/cabinet.ts`, `components/Canvas/cabinet/` | Project cabinet node: drawers hold cards and tiles moved off the canvas, stored on the node (`utils/cabinetData.ts`); whole projects in `utils/cabinetProjects.ts`; Pick mode physics in `utils/cabinetPick.ts` |
| `utils/linkTargets.ts` | `LinkRef`, `refAttr`/`parseRef`, `ownerRefs`, `remapRefs` |
| `utils/nleRows.ts` | Group layout, row positioning |
| `utils/nlePush.ts` | Collision/push for group dragging |
| `utils/contentTraversal.ts` | What content a card/deck contains |
| `hooks/useCardDecks.ts` | Deck clustering, `cardVisualRect`, `canvasObstacleGroups` |

## Conventions

- Dark theme: dark gray canvas, colored bars/cards, white text with text-shadow
- Cards: 12px radius, hero image at `opacity: 0.7`, gradient from group color
- Headers: group color brightened 15% at 25% opacity, `zIndex: 51` (cards 40, fanned wrapper 50)
- Stacked deck edges: max 2, `top: 5`, `height: screenHeight - 10`, 12px rounded
- Card text scales 1.0 → 0.7 from zoom 0.18 outward via `transform: scale()`
- Reference chips hang **half on, half off** their owner's bottom-left edge,
  at inset 14 — same on cards, blocks and elements. Where the owner's edge
  already has chrome, win the z-fight rather than moving the rail off it.
- Derived links are never stored: deck membership, viewer docking and panel
  magnetism are all recomputed, not persisted
