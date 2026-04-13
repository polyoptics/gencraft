# ProjectVidBars

GenAI video creation interface — infinite canvas of recursive semantic "bars" that compose into stories. React + TypeScript + Zustand, Vite dev server.

## Architecture

### Zoom Layers
Three rendering layers switch based on zoom level (`LayerRouter.tsx`):
- **Card layer** (zoom <= 0.18): One composite card per project group with hero image, header/body text, summary label
- **Block layer** (0.18 < zoom <= 0.30): Board-level blocks with NLE timeline headers
- **Board layer** (zoom > 0.30): Full bar editing — split, resize, content editing

### Key Data Model
- **Bar**: Atomic unit — named, colored, resizable rectangle. Recursive tree via splits
- **Board** (`BoardData`): Contains a tree of bars, belongs to a project group
- **ProjectGroup**: Groups boards into one card at card zoom. Has `originX/Y`, `color`, `cardText`, `cardHeaderText`, text styles, hero image, deck state
- **Deck**: Groups of touching cards — states: `open`, `stacked`, `fanned`

### Rendering Model
- Canvas layer: `transform: scale(zoom)` world — bars, blocks rendered in canvas space
- Overlay layer: Screen-space pixel positioning — cards, headers, affordances computed as `pan + canvasValue * zoom`
- Header extension: Cards extend upward behind `NLETimelineHeader` by `Math.max(NLE_HEADER_CANVAS_H * zoom, 20) + 2 * zoom` screen pixels. This formula must match everywhere: `GroupCard`, `StackedDeckCard`, `FannedDeckOverlay`, `CardOutline`, `cardScreenRect()`, `DeckAffordance`

### State Management
- `boardsStore.ts` — All bar/board/group data, deck operations, group CRUD
- `canvasStore.ts` — Pan, zoom, zoneLineY, focusedBoardId
- `freeNodeStore.ts` — Independent text/image nodes on canvas
- `nleViewerStore.ts` — NLE viewer open/close state per group
- `undoCoordinator.ts` — Undo/redo checkpoints

## Key Files

| File | Purpose |
|------|---------|
| `vidbars/src/components/Layers/CardLayer.tsx` | Card zoom rendering — GroupCard, StackedDeckCard, FannedDeckOverlay, DeckAffordance, GroupCardText |
| `vidbars/src/components/Layers/BlockLayer.tsx` | Block zoom rendering |
| `vidbars/src/components/Layers/BoardLayer.tsx` | Bar editing zoom |
| `vidbars/src/components/Layers/CardOutline.tsx` | Affordance outline showing card shape at block/board zoom |
| `vidbars/src/components/Layers/LayerRouter.tsx` | Zoom threshold switching |
| `vidbars/src/components/NLE/NLETimelineHeader.tsx` | Timeline header bar — transparent overlay with group color fill, draggable, renameable |
| `vidbars/src/components/NLE/NLEBlock.tsx` | Block-level rendering with color strip ear |
| `vidbars/src/store/boardsStore.ts` | Central data store |
| `vidbars/src/utils/nleRows.ts` | Group layout computation, row positioning |
| `vidbars/src/utils/nlePush.ts` | Collision/push logic for group dragging |
| `vidbars/src/utils/colorUtils.ts` | HSL/HSV conversion, color variant generation |

## Conventions

- Dark theme: dark gray canvas, colored bars/cards, white text with text-shadow
- Cards: 12px border radius, hero image at `opacity: 0.7`, gradient overlay from group color
- Headers: Solid fill using group color brightened 15% at 25% opacity, `zIndex: 51` (above cards at 40 and fanned deck wrapper at 50)
- Stacked deck edges: Max 2 edges, `top: 5`, `height: screenHeight - 10`, 12px rounded, header `rightInset` narrows to match card face
- Card text scales from 1.0 at zoom 0.18 to 0.7 at max zoom-out via CSS `transform: scale()`
- All screen-space geometry helpers must include header extension to keep outlines/affordances aligned
