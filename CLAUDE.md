# ProjectVidBars — Claude Working Document

## Project Vision

A **proof-of-concept GenAI video creation interface** built around an infinite canvas of recursive, semantic "bars." The system lets a creator compose a story spatially — dividing, naming, coloring, and filling bars with media — then pop open a viewer to define start/end frames and keyframes, which feed into video generation models (Kling, Luma, etc.).

The goal is a working wireframe that is **as real and usable as possible**, not just a mockup. Every UI element should function.

---

## Core Concept: The Bar

The **Bar** is the atomic unit of the entire system.

- A bar is a named, colored, resizable rectangle on the canvas
- Any bar can be split **horizontally or vertically** into child bars
- Child bars can themselves be split — creating a recursive tree
- Bars carry **semantic context**: @mentions of characters, locations, and items
- Bars can hold **media content**: text, images, video clips, audio
- The **size** of a bar is meaningful — it implies relative weight, duration, or emphasis
- Bars have a **bump-out** behavior: when a row is too small to show content, it collapses to icons on the left side; clicking expands it

### Bar Anatomy

```
┌─[label pill]────────────────────────────┐
│  bar name     [sub-type/role label]     │
│                                         │
│  [content area: image / text / video]   │
│                                         │
└─────────────────────────────────────────┘
```

- **Label pill** (top-left): rounded pill showing bar name + optional sub-label (Hierarchy, flow, dossier, etc.)
- **Content area**: accepts dropped media, text blocks, @mention annotations
- **Resize handles**: drag edges to resize; sibling bars adjust to fill space
- **Context menu / right-click**: split H, split V, rename, set color, open viewer, delete

---

## Bar Splitting Model

Splitting creates a **layout tree** — the parent bar subdivides into children.

### Split Rules
- **Horizontal split** → children stacked top-to-bottom (rows)
- **Vertical split** → children side-by-side (columns)
- Children fill the parent's total space proportionally
- Any child can be further split — no depth limit
- **Bottom row bump-out**: the bottommost row of a split can optionally "bump out" below the parent boundary, giving it extra visible height

### Named Divisions (from the reference designs)
| Level | Example Names |
|-------|--------------|
| Root | storyMap |
| Top strip | Title, ACT1 |
| Main area | DROP (un-assigned/placeholder) |
| Mid | The Arrival, FlashBack |
| Sub | Maridian, awakening, Main Entrance |

---

## Infinite Canvas

- Pan: middle-mouse drag or space+drag
- Zoom: scroll wheel
- Initial state: **one bar centered on canvas**, labeled with a default project name
- Canvas background: subtle dot-grid or light checkered pattern
- Bars snap to each other when dragging (optional toggle)
- Top bar of the app: project name, zoom level, toolbar icons

---

## Content System

### Droppable Content Types
| Type | Display |
|------|---------|
| Image | Fills bar background or inset thumbnail |
| Video clip | Plays on hover, shows first frame at rest |
| Audio | Waveform strip at bottom of bar |
| Text block | Scrollable text area, supports markdown |
| @mention tag | Inline chip linking to a character/location/item card |

### Semantic Context via @mentions
Each bar has a **context list**: characters, locations, and items referenced in it.
- Typing `@` in any text area shows an autocomplete picker
- Mentions appear as colored chips: 🟠 character, 🟦 location, 🟩 item
- A bar **inherits** ancestor context automatically (if DROP contains The Arrival, The Arrival inherits any @mentions from DROP)
- This context is surfaced in the **Viewer** and passed to generation models

### Entity Cards (UI Content Elements)
Characters, locations, and items are defined as **cards** with:
- Avatar / reference image
- Name + type label
- Description / notes
- These live in a side panel or library drawer and can be dragged onto bars

---

## Viewer (Popup)

When the user opens the Viewer on a bar, a **popup panel** appears over the canvas.

### Viewer Layout
```
┌──────────────────────────────────── viewer popup ────────────────────────────────────────┐
│  ┌──────────────────────────────────────────────────┐  ┌──────────────┐                  │
│  │                                                  │  │              │                  │
│  │                   VIEWER                        │  │  Draw & Edit │                  │
│  │            (image/video canvas)                 │  │    Tools     │                  │
│  │                                                  │  │              │                  │
│  └──────────────────────────────────────────────────┘  └──────────────┘                  │
│                         [  CTRLS  ]                                                       │
│  ┌──────────┐  ┌────────────────────────────────┐  ┌──────────────┐                      │
│  │  FIRST   │  │          KEYFRAMES             │  │    LAST      │                      │
│  │ (frame)  │  │  [kf1] [kf2] [kf3] [+add]     │  │  (frame)    │                      │
│  └──────────┘  └────────────────────────────────┘  └──────────────┘                      │
└───────────────────────────────────────────────────────────────────────────────────────────┘
       [UNTITLED tab]  [SHOT1 tab]  ...
       ┌─────────────────────────────────────────────┐
       │  (the bar canvas shown below, in context)   │
       └─────────────────────────────────────────────┘
```

### Viewer Sections

**FIRST** — The start frame for this bar's video segment
- Can be a drawn/painted frame, an uploaded image, or AI-generated
- Click to open full draw/edit tools on that frame

**LAST** — The end frame
- Same capabilities as FIRST

**KEYFRAMES** — Optional intermediate frames
- Click `+` to add a keyframe at a position (time or proportional)
- Each keyframe is an image with the same draw/edit capabilities
- Keyframes give the generator more directional guidance

**CTRLS** — Generation controls
- Duration (seconds)
- Motion intensity / camera movement style
- Model selector (Kling, Luma, Runway, etc.)
- Generate button → submits FIRST + KEYFRAMES + LAST + semantic context to the model API

**Draw & Edit Tools** (right panel)
- Brush, eraser, shapes, text overlay
- Color picker, opacity
- Layer controls (for compositing reference elements)
- These work on whichever frame is currently active (FIRST / keyframe / LAST)

---

## Pop-Out History Panel

Triggered by a "POP OUT" button on the viewer. Slides out to the right or floats.

```
┌─ History Panel ──────────────────────────┐
│  VideoSession2                           │
│  ┌───┐ ┌───┐ ┌───┐                      │
│  │vid│ │vid│ │vid│  (thumbnail grid)    │
│  └───┘ └───┘ └───┘                      │
│  VideoSession1                           │
│  ┌───┐ ┌───┐                            │
│  │vid│ │vid│                            │
│  └───┘ └───┘                            │
│  generation history bin                 │
└──────────────────────────────────────────┘
```

- Sessions are grouped by generation run
- Click any thumbnail to load it back into FIRST/LAST/keyframe slot
- Thumbnails show model used, duration, timestamp

---

## File System Integration

**Critical design principle**: The bar hierarchy is NOT just visual. Each bar maps to an actual directory on disk.

```
project/
├── storyMap/
│   ├── DROP/
│   │   ├── images/
│   │   └── drop/         ← drag-dropped media lands here
│   ├── The_Arrival/
│   │   ├── Maridian/
│   │   └── Main_Entrance/
│   └── FlashBack/
│       └── Waiting_Area/
├── creator/
│   └── storyinner/
│       └── gather/       ← entity cards (characters, locations, items)
├── project/
│   └── archive/          ← saved generation outputs
└── log/
    └── GameRoot/         ← session logs
```

- Creating a bar creates its directory
- Renaming a bar renames its directory
- Deleting a bar moves its directory to archive (no hard delete)
- Dropping media into a bar copies/moves the file into that bar's `images/` or `drop/` subfolder

---

## Semantic Generation Pipeline

When "Generate" is triggered from the Viewer:

1. **Collect context** from the bar and all ancestors (resolved @mentions → entity card data)
2. **Collect frames**: FIRST image, KEYFRAMES images (ordered), LAST image
3. **Collect controls**: duration, motion style, model
4. **Build payload**:
   ```json
   {
     "bar": "The Arrival",
     "context": {
       "characters": ["A.Yuki (craneOrder, humanoid)", "O.Gradius"],
       "locations": ["MainEntrance", "Lobby [WIP]"],
       "items": ["VisorSFX"]
     },
     "prompt": "@A.Yuki meets @O.Gradius at the @Maridian @MainEntrance. Also showing: @Lobby [WIP], @ITEM [place holder], @VisorSFX [created]",
     "frames": {
       "first": "<base64 or URL>",
       "keyframes": ["<kf1>", "<kf2>"],
       "last": "<base64 or URL>"
     },
     "duration": 5,
     "motion": "cinematic",
     "model": "kling"
   }
   ```
5. **Submit** to model API (mocked/stubbed in POC)
6. **Store result** in generation history, update history panel thumbnail grid

---

## Tech Stack (Recommended for POC)

| Layer | Choice | Reason |
|-------|--------|--------|
| Framework | React + TypeScript | Component model maps well to bar tree |
| Canvas/layout | CSS Grid + absolute positioning | Bars are div-based, not WebGL — easier to embed real content |
| Infinite canvas | `@use-gesture/react` + CSS transforms | Pan/zoom without a heavy canvas lib |
| Resize/drag | `react-rnd` or custom resize handles | Bars need drag-resize with sibling reflow |
| State | Zustand | Simple tree state for bar hierarchy |
| File system | Electron (if desktop) or File System Access API (browser) | Real directory mapping |
| Styling | Tailwind CSS | Fast iteration on the visual design |
| Viewer draw tools | `fabric.js` or `konva` canvas inside viewer | Needed for drawing on frames |

---

## Key UX Behaviors to Implement

1. **Single bar on load** — canvas opens with one bar centered, default name, blue color
2. **Right-click context menu** on any bar: Split H, Split V, Rename, Set Color, Add Content, Open Viewer, Delete
3. **Drag edge to resize** — sibling bars adjust; minimum bar size enforced
4. **Bump-out row** — bars below a certain height threshold switch to icon-strip mode; click to expand
5. **@mention autocomplete** — typing `@` in any text area triggers entity picker
6. **Drag media onto bar** — image/video appears in bar; file saved to bar's directory
7. **Viewer open** — slides up or appears as overlay; maintains canvas context below it
8. **Generation mock** — "Generate" button shows a progress animation then places a placeholder video thumbnail in history
9. **Tab system** in viewer — multiple shots/takes per bar (UNTITLED, SHOT1, etc.)

---

## Visual Design Language

- **Background**: dark gray canvas with subtle dot grid
- **Bars**: rounded corners (8-12px radius), solid fill colors, thin dark border
- **Color palette**: blues (default/unassigned), teals (scenes), orange (flashback/alt timeline), light blue (title/header strips)
- **Label pills**: rounded pill shape, slightly darker than bar, top-left anchored
- **Typography**: clean sans-serif, white text on colored bars
- **Viewer**: warm off-white/sand background (distinct from canvas)
- **History panel**: dark, card-based layout

---

## Development Phases

### Phase 1 — Canvas + Bars
- [ ] Infinite canvas with pan/zoom
- [ ] Single bar on load
- [ ] Right-click to split H/V
- [ ] Rename bar (double-click label)
- [ ] Resize by dragging edges
- [ ] Color picker per bar
- [ ] Bump-out behavior for small bars

### Phase 2 — Content
- [ ] Text area in bar with @mention support
- [ ] Image drop onto bar
- [ ] Entity card library panel (characters, locations, items)
- [ ] Context inheritance (child bars see ancestor @mentions)

### Phase 3 — Viewer
- [ ] Viewer popup (triggered from bar context menu)
- [ ] FIRST / LAST frame slots (upload or draw)
- [ ] KEYFRAME strip with add/remove
- [ ] Draw tools panel (basic brush/erase on frames)
- [ ] CTRLS: duration, model selector, generate button

### Phase 4 — Generation + History
- [ ] Mock generation API call (returns placeholder video)
- [ ] History panel with session grouping and thumbnails
- [ ] Click thumbnail to load into frame slot

### Phase 5 — File System
- [ ] Directory creation on bar create/rename
- [ ] Media file copy on drop
- [ ] Archive on delete
- [ ] Project save/load (JSON manifest)

---

## Reference Images

All reference images are in the project root:
- `storybarsOverView.jpg` — bar hierarchy overview showing filter/semantic variants
- `simpleBarSplitExamples_001.jpg` — initial split, resize, additional split progression
- `simpleBarSplitExamples_002.jpg` — color coding and bump-out layout
- `simpleBarSplitExamples_003.jpg` — content added (images, @mention text blocks, character dossiers)
- `simpleBarSplitExamples_004.jpg` — small row icon mode + scene description shorthand
- `UiContentElements.jpg` — entity card designs (character, location, item cards)
- `viewer_001_popUpViewerEditor.jpg` — viewer popup layout
- `viewer_002_popUpViewerEditorWithPopOutHistory.jpg` — viewer + pop-out history panel
