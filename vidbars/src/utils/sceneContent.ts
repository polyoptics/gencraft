// What a card puts on a scene division's face when let go on it (Brian
// 2026-11-07): its header, its paragraph text and its picture, COPIED. The
// division keeps a link back to the card and a note of what it copied, so
// it can tell the card changed since (contentOf differs) and take the new
// content on a click, keeping its own look and crop.

import { useBoardsStore, type ProjectGroup } from '../store/boardsStore'
import { cardFaceMedia } from './cardGrid'
import { fillFields } from './faceStyle'
import { findDiv, heldCard, isLeaf, patchDiv, type SceneDiv } from './sceneCard'

/** A card's face content: its header text, paragraph text, picture. Not
 *  its name (a file name, often): only what is on its face. */
export function contentOf(card: ProjectGroup): { name: string; notes: string; image?: string } {
  const bs = useBoardsStore.getState()
  const face = cardFaceMedia(card, bs.boards)
  const image = face?.type === 'image' ? face.url : face?.posterUrl ?? undefined
  return {
    name: fillFields(card.cardHeaderText ?? '', bs.groups, card.id).trim(),
    notes: fillFields(card.cardText ?? '', bs.groups, card.id).trim(),
    ...(image ? { image } : {}),
  }
}

const sig = (c: ReturnType<typeof contentOf>) => JSON.stringify([c.name, c.notes, c.image ?? ''])

/** The division's face from this card, and the note of what came. With
 *  look (a card let go on it): the card's text styles, split and picture
 *  settings too; a refresh takes the content only. */
export function copyFrom(card: ProjectGroup, look = true): Partial<SceneDiv> {
  const c = contentOf(card)
  const content: Partial<SceneDiv> = { face: true, name: c.name, notes: c.notes, image: c.image, copied: sig(c) }
  if (!look) return content
  const t = card.cardHeroTransform
  return {
    ...content,
    hstyle: card.cardHeaderTextStyle ? { ...card.cardHeaderTextStyle } : undefined,
    bstyle: card.cardTextStyle ? { ...card.cardTextStyle } : undefined,
    split: card.textSplitRatio,
    hero: t ? { flipH: t.flipH, flipV: t.flipV, opacity: t.opacity } : undefined,
  }
}

/** The card a division came from changed its content since. */
export function cardChanged(d: SceneDiv, card: ProjectGroup | undefined): boolean {
  return !!card && !!d.copied && d.copied !== sig(contentOf(card))
}

/** Cards let go on a division: their faces copied in (utils/sceneCard putCards). */
export function dropCardsInDivision(sceneId: string, divId: string, cardIds: string[]): void {
  const bs = useBoardsStore.getState()
  bs.putCardsInDivision(sceneId, divId, cardIds, id => {
    const g = useBoardsStore.getState().groups.find(x => x.id === id)
    return g ? copyFrom(g) : {}
  })
}

/** The card's new content into the division; its look and crop stay. */
export function refreshDivision(sceneId: string, divId: string): void {
  const bs = useBoardsStore.getState()
  const scene = bs.groups.find(g => g.id === sceneId)?.scene
  const d = scene ? findDiv(scene, divId) : null
  const card = d ? bs.groups.find(g => g.id === heldCard(d)) : undefined
  if (!scene || !d || !card) return
  bs.setGroupScene(sceneId, patchDiv(scene, divId, copyFrom(card, false)))
}

/** Divisions holding a card from before faces were copied (2026-11-07):
 *  copy theirs in now, once. Null when there are none. */
export function migrateScene(root: SceneDiv): SceneDiv | null {
  const groups = useBoardsStore.getState().groups
  let changed = false
  const walk = (d: SceneDiv): SceneDiv => {
    if (!isLeaf(d)) return { ...d, kids: d.kids!.map(walk) }
    const id = heldCard(d)
    if (!id || d.face) return d
    // Copied already (06700bd): it keeps what is on it, as a face now.
    if (d.copied) { changed = true; return { ...d, face: true } }
    const card = groups.find(g => g.id === id)
    if (!card) return d
    changed = true
    const c = copyFrom(card)
    // The card's own text boxes are its titles now (Brian 2026-11-07).
    return { ...d, card: id, cards: undefined, ...c, mid: true, tab: false, hs: undefined, ts: undefined }
  }
  const next = walk(root)
  return changed ? next : null
}
