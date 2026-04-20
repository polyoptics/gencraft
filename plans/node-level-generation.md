# Node-Level AI Generation

## Context

Every bar (node) on the canvas sits inside a neighborhood — siblings with the same parent, its parent bar, its containing board, its group, and possibly a deck. The user should be able to click a small "generate" affordance on any bar and get an AI-generated result where the "prompt" is automatically built from that neighborhood. The demo pitch: *"You don't tell it what's going on. It already knows."*

This is a prototype feature, not production. Generation is **mocked** — matches the existing 2.2s `setTimeout` pattern in `Viewer.tsx`. The point is to land the demo moment, not to wire a real LLM.

Scoped to **board-level zoom only** for v1 (inside `NLEBlock`), where the user sees a bar fully and edits it.

## Approach

### 1. UI affordance — AI pill in the hover overlay

Add a third pill to `NLEBlock`'s hover-revealed action area (near the existing `Parent` / `Child` pills around line 1053 in `vidbars/src/components/NLE/NLEBlock.tsx`).

- Label: `✦ AI`
- Coral accent ring (`#ff6b5a`) to distinguish from structural pills
- Reuses existing `overlayPill` style
- Zero real-estate cost when idle (only shows on hover)

Click → opens a popover anchored to the bar's rect.

### 2. Generation popover

**New file:** `vidbars/src/components/AIGeneration/AIGenerationPopover.tsx` (~180 lines)

Props: `{ boardId, barId, anchorRect, onClose }`. Portaled to `document.body`. Closes on outside click and Escape — reuses the pattern from `ColorPickerPopup` / `CircularColorPicker`.

**Layout (top to bottom, ~320px wide, dark navy surface matching the Viewer):**

1. Header row — `Generate for <bar.name>` in Georgia serif, with a `×` close button.
2. **Context chips** — horizontal wrap. Each chip shows: `Parent: <name>`, `Siblings: <N>`, `Board: <name>`, `Group: <name>`, `Deck: <name>`, `Children: <N>`. Only renders chips that actually exist. Coral-tinted backgrounds.
3. **Content type selector** — segmented control: `Text` / `Image`. Default: `Text` if the bar has no body text, else `Image`.
4. **Text target** (when Text selected) — radio `Header` / `Body`. Default: whichever field is empty.
5. **Nudge input** — single-line, placeholder `Add a hint (optional)… Enter to generate`. Coral border on focus. Enter submits.
6. **Generate button** — full-width coral, disables during the mock wait with label `Generating…`.
7. **Footer hint** — small muted text: `Uses neighborhood context automatically`.

### 3. Context assembly helper

**New file:** `vidbars/src/utils/barNeighborhood.ts` (~50 lines).

Pure function, no hooks. Returns `null` if the bar can't be resolved.

```ts
export interface BarNeighborhood {
  self:     { id: string; name: string; text: string; headerText?: string }
  parent:   { id: string; name: string } | null
  siblings: Array<{ id: string; name: string }>
  children: Array<{ id: string; name: string }>
  board:    { id: string; name: string }
  group:    { id: string; name: string } | null
  deck:     { id: string; memberCount: number } | null
}

export function getBarNeighborhood(
  boardId: string,
  barId: string,
  boards: Record<string, BoardData>,
  groups: ProjectGroup[],
  getDeckForGroup: (gid: string) => Deck | null,
): BarNeighborhood | null
```

Reuses existing utilities:
- `getGroupForBoard(groups, boardId)` — `vidbars/src/store/boardsStore.ts` line 64
- `useCardDecks` hook → `getDeckForGroup` — `vidbars/src/hooks/useCardDecks.ts`
- `bar.parentId` + parent's `children[]` for siblings
- `bar.children[]` for the node's own children

### 4. Mock generation

**New file:** `vidbars/src/utils/mockGeneration.ts` (~70 lines).

- **Text library** — ~15 canned snippets themed to Pelagia-9 / Gen-Film worlds. Deterministic-but-varied pick from `hash(barId + timestamp + nudge)`.
- **Template fallback** — wraps the picked snippet with neighborhood context.
- **Image library** — 6–8 `picsum.photos?seed=<hash>` URLs.
- Both functions return a `Promise` after `await new Promise(r => setTimeout(r, 2200))` — matches `Viewer.tsx:191`.

### 5. Writing back to the bar

Text → `setContent(boardId, barId, { text: '…' })` or `{ headerText: '…' }`
Image → `setContent(boardId, barId, { media: [...existing, { url, type: 'image', originalName: 'generated.jpg' }] })`

No store, type, or model changes. `setContent` is already the single write path (`boardsStore.ts:567`).

Undo: `useUndoCoordinator.getState().checkpoint()` is called **just before** the `setContent` write (not before the 2.2s wait).

## Files

| File | Change |
|------|--------|
| `vidbars/src/components/AIGeneration/AIGenerationPopover.tsx` | New — popover component |
| `vidbars/src/utils/barNeighborhood.ts` | New — context assembly helper |
| `vidbars/src/utils/mockGeneration.ts` | New — themed snippet libraries + 2.2s mock |
| `vidbars/src/components/NLE/NLEBlock.tsx` | Edit — add `✦ AI` pill in hover overlay (~line 1053), add popover render (~line 1111), add `showAIPopover` state (~line 125) |

Total new code: ~300 LOC. No changes to stores, types, or content model.

## Verification

1. Zoom to board level.
2. Hover a bar with a parent and siblings → `✦ AI` pill appears.
3. Click pill → popover opens. Chips correctly show parent, sibling count, board, group. Deck chip only when the group is in a deck.
4. Text / Body selected, empty nudge → press Enter → after ~2.2s the body text populates inline.
5. Ctrl+Z → generated text disappears.
6. Switch to Image → Generate → image appears in the bar's hero area (`HeroImageLayer` picks it up via `getFirstImageUrl`).
7. Rootless bar → no parent/group chips, no error.
8. Two different bars in the same board → each shows its own context.

## Notes

- v1 is text + image only. Video stays in the existing `Viewer`.
- Popover styling matches the Viewer aesthetic.
- The demo-critical moment is the **context chips appearing automatically** — that's where "it already knows" lands.
