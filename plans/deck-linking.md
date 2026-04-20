# Deck Linking — Chips + Parented Ghost Expansion

## Context

Reference one card (or whole deck) from another without physically nesting it as a sub-deck. Working on a story deck (Gen-Film Swarm), pull in Pelagia-9's plants/characters/locations as references — see them together when useful, but keep each deck's original spatial layout intact.

Pattern (from the user's Miro planning board): chips attached to a card's edge represent linked cards; clicking a chip materializes the linked card as a "parented ghost" positioned adjacent to the host. Ghosts have their own chips and can be expanded recursively into a tree. The real card stays at its canonical canvas position. Spatial adjacency is enough to convey the relationship — no visual connector needed.

**Scope:** card-zoom only for v1. Links are group-to-group, bi-directional. Linking to a deck's anchor group naturally surfaces the deck in expansion.

## Approach

### 1. Data model

Add one field to `ProjectGroup` in `vidbars/src/store/boardsStore.ts`:

```ts
linkedGroupIds: string[]   // bi-directional — maintained in pairs
```

Two new store actions:
```ts
linkGroups(a: string, b: string) => void      // adds b to a and a to b
unlinkGroups(a: string, b: string) => void    // removes from both
```

Persist-store bump: version 10 → 11. Migration backfills `linkedGroupIds: []` on all existing groups.

### 2. Chip rail on each card

New file: `vidbars/src/components/Linking/LinkChipRail.tsx` (~80 lines).

Horizontal row of chips on the **bottom-left edge** of a card. Each chip:
- Linked group's color strip + mini hero thumbnail + first 10 chars of name
- ~60–80px wide × ~24px tall, rounded-right, sticks out slightly
- Hover → fade in `×` to unlink
- Click → toggle expansion of this link's ghost card
- Double-click → jump pan/zoom to the linked card's canonical position

Trailing `+` chip opens the link picker.

Used inside `GroupCard` / `StackedDeckCard` / `FannedDeckOverlay` primary card. Only at card zoom (≤ 0.18).

### 3. Parented ghost card (expansion)

New file: `vidbars/src/components/Linking/LinkedGhostCard.tsx` (~120 lines).

Click a chip → a **ghost card** materializes in canvas-space, positioned below+right of the host.

**Position:** deterministic tile (host height × 0.25 + gap). Multiple expanded ghosts stack vertically. Nested ghosts tile off their own parent.

**Visuals:**
- Same geometry as GroupCard, 60–75% scale
- Dashed border + slight transparency → reads as "reference, not canonical"
- Header badge: `↗ <host name>` with close `×`
- Double-click ghost header → pan/zoom to canonical location

**Implementation:** minimal visual composed of the linked group's `cardHeaderText`, `cardText`, `cardHeroImage`, color. Edits, resize, context menu happen on the canonical card after a jump. Chip rail on the ghost is wired (so expansion recurses).

### 4. Link picker modal

New file: `vidbars/src/components/Linking/LinkPickerModal.tsx` (~100 lines).

Portaled (pattern from `ColorPickerPopup`). Opens from the `+` chip or "Manage Links…" in the context menu.

- Search box at top
- Scrollable list of other groups (exclude self + already-linked)
- Each row: color dot + name + small hero
- Click row → toggle link (bi-directional via store)
- Outside-click / Escape to close

### 5. Expansion state (not persisted)

New file: `vidbars/src/store/linkingStore.ts` (~30 lines).

```ts
interface LinkingStore {
  // Path = sequence of group ids from root host through nested expansions
  expandedPaths: Set<string>   // serialized as "a>b>c"
  isExpanded: (path: string[]) => boolean
  toggleExpanded: (path: string[]) => void
  closeAll: () => void
}
```

Paths let Pelagia-9 be expanded under different hosts without conflating state. Not persisted — view session, not content.

### 6. Jump navigation

New action on `useCanvasStore` in `vidbars/src/store/canvasStore.ts`:

```ts
jumpToGroup(groupId: string) => void
```

Computes the group's canvas bounds (mirrors `GroupCard`'s geometry math at `CardLayer.tsx:306–361`), sets pan + zoom to center with padding.

Called from: chip double-click, ghost header double-click, picker modal "go to" icon.

### 7. Bi-directional maintenance

A and B get each other in `linkedGroupIds`. Only `linkGroups`/`unlinkGroups` touch the field. Invariant: "A links B ⇔ B links A."

Reverse-link UX: viewing Pelagia-9 shows chips pointing to Gen-Film Swarm. That's the "it knows it's referenced" property.

## Files

| File | Change |
|------|--------|
| `vidbars/src/components/Linking/LinkChipRail.tsx` | New |
| `vidbars/src/components/Linking/LinkedGhostCard.tsx` | New |
| `vidbars/src/components/Linking/LinkPickerModal.tsx` | New |
| `vidbars/src/store/linkingStore.ts` | New |
| `vidbars/src/store/boardsStore.ts` | Edit — `linkedGroupIds` + `linkGroups`/`unlinkGroups` + v11 migration |
| `vidbars/src/store/canvasStore.ts` | Edit — `jumpToGroup(groupId)` |
| `vidbars/src/components/Layers/CardLayer.tsx` | Edit — render chip rails in card components, ghost tree in Overlay, add "Manage Links…" to CardContextMenu |

Total new code: ~400 LOC. No changes to BoardData, Bar, or content model.

## Verification

1. Zoom to card level.
2. Right-click a card → "Manage Links…" → pick another card → close.
3. Chip appears on bottom-left showing linked card's color/name.
4. Switch to linked card — reverse chip is there (bi-directional).
5. Click chip → ghost materializes below/right at 60–75% scale, dashed border.
6. Ghost has its own chip rail — click a nested chip, tree grows.
7. Double-click chip / ghost header → canvas pans/zooms to canonical card.
8. Remove link (`×` or via picker) → chip disappears on BOTH cards, all ghosts close.
9. Reload — links persist, expansion state does not.
10. Link a deck anchor — expansion shows the deck (stacked/fanned per state).
11. At block/board zoom — chips and ghosts are invisible.

## Notes / future

- Circular refs: fine (it's a graph).
- Deep trees: no cap in v1.
- Editing in ghost: out of scope for v1. Ghosts are read-only views.
- v2: a single "Pelagia-9 deck (4 cards)" chip that expands all deck members at once.
