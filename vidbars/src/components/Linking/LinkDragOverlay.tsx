// LinkDragOverlay — renders the dashed line + floating circle that trails
// the cursor while a link-drag is in progress. Also owns the global
// pointermove/pointerup listeners that drive the drag. Mounted once at the
// App root. Motion matches the NLEBlock color drag-out pattern.

import { dropCardsInDivision } from '../../utils/sceneContent'
import { addState, setStateDeck } from '../../utils/stateCard'
import React, { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useLinkDragStore } from '../../store/linkDragStore'
import { useBoardsStore } from '../../store/boardsStore'
import { parseRef, sameRef, type LinkRef } from '../../utils/linkTargets'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { linkCardToStoryPoint, standingStoryDrop, storyLinkOf, unlinkCardFromStorylines } from '../Canvas/StorylineLayer'

export const LinkDragOverlay: React.FC = () => {
  const active = useLinkDragStore(s => s.active)
  const start = useLinkDragStore(s => s.startScreenPos)
  const pos = useLinkDragStore(s => s.currentPos)
  const color = useLinkDragStore(s => s.sourceColor)
  const move = useLinkDragStore(s => s.move)
  const end = useLinkDragStore(s => s.end)

  // Install global listeners while a drag is active
  useEffect(() => {
    if (!active) return

    const onMove = (e: PointerEvent) => move(e.clientX, e.clientY)
    const onUp = (e: PointerEvent) => {
      const source = useLinkDragStore.getState().source
      if (!source) { end(); return }
      // Find drop target: look for [data-link-drop] ancestor at release point
      const els = document.elementsFromPoint(e.clientX, e.clientY)
      let target: LinkRef | null = null
      // A Storyline's point ("story:<node>:<point>", ":up"/":down" on a stem's
      // tick end): a card let go on it moves with it (StorylineLayer).
      let story: string[] | null = null
      // A detail on a card's back ("detail:<card>:<detail id>|new"): a
      // card let go there is what that detail shows (CardBack).
      let detail: string[] | null = null
      // A division of a scene card ("division:<scene>:<division>"): the
      // card let go goes in it, with the others selected with it (SceneFace).
      let division: string[] | null = null
      // A state on a State card ("statedeck:<card>:<state>|new"): the deck
      // the card let go is in becomes that state's deck (StateFace).
      let stateDeck: string[] | null = null
      for (const el of els) {
        const attr = (el as HTMLElement).closest?.('[data-link-drop]')?.getAttribute('data-link-drop')
        if (!attr) continue
        if (attr.startsWith('story:')) { story = attr.split(':'); break }
        if (attr.startsWith('detail:')) { detail = attr.split(':'); break }
        if (attr.startsWith('division:')) { division = attr.split(':'); break }
        if (attr.startsWith('statedeck:')) { stateDeck = attr.split(':'); break }
        // "group:<id>" / "board:<id>" / "bar:<boardId>:<barId>", plus the
        // legacy "card:"/"chip:" spellings the card layer still emits.
        const hit = parseRef(attr)
        if (!hit) continue
        // THE TOPMOST TARGET WINS, whatever it is. elementsFromPoint returns
        // the whole stack, not just the top hit, so skipping the source and
        // continuing meant the search fell THROUGH the thing you released on
        // and linked whatever happened to lie behind it. Harmless while cards
        // never overlapped; with a pinned card floating over the canvas it
        // fired on every plain click of that card's own "+" chip, and with
        // nested bars almost every release is over a stack. Releasing over
        // the source now cancels, which is what releasing where you started
        // should do anyway.
        if (!sameRef(hit, source)) target = hit
        break
      }
      // Over a storyline standing up in the tilted view: the drop is re-sent at
      // the ground's flat point, where the wall is not; it saw the point.
      // It was the topmost drop target in the view as seen, so it wins.
      const onWall = standingStoryDrop()
      if (onWall) { story = onWall.split(':'); target = null }
      // A card's link "+" let go on bare canvas (nothing to link to, not
      // back on itself): a card hanging on a storyline is let go from it.
      const bare = !story && !target && els.some(el => (el as HTMLElement).matches?.('[data-tilt-stage="world"], [data-world]'))
        && !els.some(el => (el as HTMLElement).closest?.('[data-link-drop], [data-group-card]'))
      if (bare && source.kind === 'group' && storyLinkOf(source.id)) {
        useUndoCoordinator.getState().checkpoint()
        unlinkCardFromStorylines(source.id)
      }
      if (detail && source.kind === 'group' && source.id !== detail[1]) {
        useUndoCoordinator.getState().checkpoint()
        useBoardsStore.getState().linkGroupDetail(detail[1], detail[2], source.id)
      }
      if (division && source.kind === 'group' && source.id !== division[1]) {
        useUndoCoordinator.getState().checkpoint()
        const bs = useBoardsStore.getState()
        const ids = bs.selectedGroupIds.includes(source.id) ? [source.id, ...bs.selectedGroupIds.filter(id => id !== source.id)] : [source.id]
        dropCardsInDivision(division[1], division[2], ids)
      }
      if (stateDeck && source.kind === 'group' && source.id !== stateDeck[1]) {
        if (stateDeck[2] === 'new') addState(stateDeck[1], { deck: source.id })
        else setStateDeck(stateDeck[1], stateDeck[2], source.id)
      }
      if (story && source.kind === 'group') {
        useUndoCoordinator.getState().checkpoint()
        linkCardToStoryPoint(story[1], story[2], source.id, story[3])
      }
      if (target) {
        // Checkpoint HERE, not when the drag began: a checkpoint per
        // abandoned gesture buries the edit the user actually wants back,
        // and this is the one place that knows a link was really made — for
        // all three source kinds at once.
        useUndoCoordinator.getState().checkpoint()
        // Direction convention: the DROP TARGET owns the reference. Dropping
        // A onto B means "B references A" — B gets a prominent primary chip
        // pointing at A, A gets a small back-ref chip pointing at B.
        useBoardsStore.getState().linkRefs(target, source)
        // Onto a FACTION or a FAMILY, a card that is one of several
        // selected brings them all in as members (CardBack): fifty
        // characters sort into factions a selection at a time, not one
        // link at a time.
        const bs = useBoardsStore.getState()
        const t = target
        if (t.kind === 'group' && source.kind === 'group' && ['faction', 'family'].includes(bs.groups.find(g => g.id === t.id)?.cardType ?? '')
          && bs.selectedGroupIds.includes(source.id)) {
          for (const id of bs.selectedGroupIds) if (id !== t.id) bs.linkGroups(t.id, id)
        }
      }
      end()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') end()
    }

    // pointercancel matters as much as pointerup: the browser can take the
    // gesture away (touch scroll, pen leaving range) and without this the
    // dashed line hangs on screen with no way to dismiss it.
    const onCancel = () => end()

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKey)
    }
  }, [active, move, end])

  if (!active || !start || !pos) return null

  return createPortal(
    <div
      style={{
        position: 'fixed', left: 0, top: 0,
        width: '100vw', height: '100vh',
        pointerEvents: 'none',
        zIndex: 99998,
      }}
    >
      {/* Floating circle at cursor */}
      <div style={{
        position: 'absolute',
        left: pos.x - 14,
        top: pos.y - 14,
        width: 28, height: 28,
        borderRadius: '50%',
        background: color,
        border: '2.5px solid rgba(255,255,255,0.8)',
        boxShadow: `0 0 12px ${color}, 0 4px 16px rgba(0,0,0,0.55)`,
        transition: 'none',
      }} />
      {/* Dashed line from source to cursor */}
      <svg style={{
        position: 'absolute', left: 0, top: 0,
        width: '100%', height: '100%',
        overflow: 'visible',
      }}>
        <line
          x1={start.x} y1={start.y}
          x2={pos.x} y2={pos.y}
          stroke={color}
          strokeWidth={2}
          strokeDasharray="6 4"
          opacity={0.55}
        />
      </svg>
    </div>,
    document.body
  )
}
