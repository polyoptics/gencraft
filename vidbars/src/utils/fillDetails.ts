// "Fill in details" (Brian 2026-11-04): select cards and fill in what
// they leave empty, made up to fit their type: a character's ID, licence,
// body, age, height, weight, role and stats; a location's building and
// floors; a prop's ammo; and so on. Only empty values are filled (what is
// typed or linked stays). A card still carrying the name it came with
// (none, or its file's) gets a new one (utils/nameGen), never one used
// before. A character's BODY (human, mechanical, hybrid or mutated) sets
// the ranges its height, weight, age and stats come from.

import type { ProjectGroup } from '../store/boardsStore'
import { cardTypeOf, withTypeDetails, type CardDetail, type CardType } from './cardTypes'
import { int, makeName, pick, placeName, type NameKind } from './nameGen'

type Rnd = () => number

export const BODIES = ['Human', 'Mechanical', 'Hybrid', 'Mutated'] as const
type Body = typeof BODIES[number]

/** What a body is built like: the ranges a character's numbers come from.
 *  Weight from height and build (kg per m², so tall is heavier): metal is
 *  heavy, a mutation can go any way. */
const BUILD: Record<Body, { age: [number, number]; height: [number, number]; perM2: [number, number]; str: [number, number]; spd: [number, number]; wits: [number, number] }> = {
  Human:      { age: [16, 68], height: [150, 198], perM2: [18, 30], str: [2, 7],  spd: [3, 8],  wits: [3, 9] },
  Mechanical: { age: [2, 60],  height: [165, 235], perM2: [45, 90], str: [6, 10], spd: [3, 7],  wits: [2, 8] },
  Hybrid:     { age: [18, 60], height: [160, 212], perM2: [26, 40], str: [5, 9],  spd: [4, 9],  wits: [3, 8] },
  Mutated:    { age: [12, 80], height: [140, 240], perM2: [15, 45], str: [3, 10], spd: [2, 10], wits: [1, 9] },
}

/** The kind of name a card of this type gets (none: it keeps its own). */
export function nameKindOf(type: CardType): NameKind | null {
  return type === 'character' || type === 'faction' || type === 'location' || type === 'prop' ? type : null
}

/** A card still named what it came with: nothing, "Untitled", or its
 *  file's name (character_1, IMG_2041, render.png). */
export function placeholderName(name: string | undefined): boolean {
  const n = (name ?? '').trim()
  if (!n || /^(untitled|new card|card)$/i.test(n)) return true
  if (/\.(png|jpe?g|webp|gif|mp4|mov|webm|tiff?|bmp|exr|psd)$/i.test(n)) return true
  return n.includes('_') || /^(img|image|dsc|pic|photo|screenshot|render|output|frame|comfyui|card)[\s-]*\d+/i.test(n)
}

const LETTERS = 'ABCDEFGHJKLMNPRSTVWXZ'
const L = (rnd: Rnd) => pick(rnd, LETTERS.split(''))
const pad = (n: number) => String(n).padStart(2, '0')

const LICENCE = ['Salvage B', 'Water rights', 'Courier', 'Medic (lapsed)', 'None', 'Revoked', 'Trade, grey market', 'Drive class 2',
  'Arms permit', 'Forged', 'Scrap dealer', 'Signal operator', 'Reactor crew', 'Wall pass', 'Day pass, expired', 'Bounty, open']
const ROLE = ['Scavenger', 'Mechanic', 'Medic', 'Runner', 'Trader', 'Gunhand', 'Preacher', 'Driver', 'Lookout', 'Smuggler', 'Cook',
  'Signal tech', 'Water boss', 'Tinkerer', 'Courier', 'Bounty hunter', 'Farmer', 'Drone jockey', 'Fixer', 'Scout', 'Enforcer', 'Barkeep']
const BUILDING: [string, [number, number]][] = [['Mall', [1, 3]], ['Water tower', [1, 1]], ['Parking garage', [3, 8]], ['Chapel', [1, 2]],
  ['Motel', [1, 2]], ['Grain silo', [1, 1]], ['Rail yard', [1, 1]], ['Dam', [2, 6]], ['Clinic', [1, 4]], ['Radio mast', [1, 1]],
  ['Reactor hall', [2, 5]], ['Overpass camp', [1, 2]], ['Dome farm', [1, 2]], ['Server farm', [1, 3]], ['Hangar', [1, 2]],
  ['Bunker', [1, 3]], ['Tenement', [4, 20]], ['Fuel depot', [1, 2]], ['Tower block', [12, 40]], ['Desalination plant', [2, 4]]]
const USE = ['Residential', 'Commercial', 'Industrial', 'Mixed', 'Abandoned', 'Military', 'Farming', 'Market', 'Squat']
const BASEMENT = ['Yes', 'No', 'Flooded', 'Two levels', 'Sealed', 'Collapsed', 'Bunker below']
/** Gear: its kind, what it takes, and how much of it. */
const KIND: { kind: string; ammo?: string; cap: (r: Rnd) => string }[] = [
  { kind: 'Pipe rifle', ammo: 'Scrap rounds', cap: () => '1' },
  { kind: 'Rail pistol', ammo: 'Steel slugs', cap: r => String(int(r, 4, 8)) },
  { kind: 'Nail gun', ammo: 'Roofing nails', cap: r => String(int(r, 20, 60)) },
  { kind: 'Arc baton', ammo: 'Battery cells', cap: r => `${int(r, 3, 9)} charges` },
  { kind: 'Scrap machete', cap: () => '—' },
  { kind: 'Crossbow', ammo: 'Rebar bolts', cap: () => '1' },
  { kind: 'Flare gun', ammo: 'Flares', cap: () => '1' },
  { kind: 'Sawn-off', ammo: '12 gauge', cap: () => '2' },
  { kind: 'Plasma cutter', ammo: 'Gas canister', cap: r => `${int(r, 10, 40)} min` },
  { kind: 'Ion carbine', ammo: 'Ion cells', cap: r => String(int(r, 12, 30)) },
  { kind: 'Geiger counter', cap: r => `${int(r, 2, 9)} days` },
  { kind: 'Gas mask', cap: r => `${int(r, 2, 8)} hrs` },
  { kind: 'Field radio', cap: r => `${int(r, 5, 40)} km` },
  { kind: 'Water filter', cap: r => `${int(r, 50, 400)} L` },
  { kind: 'Grapple gun', ammo: 'Cable', cap: r => `${int(r, 15, 60)} m` },
  { kind: 'Scout drone', ammo: 'Battery cells', cap: r => `${int(r, 10, 45)} min` },
]
const MOOD = ['Grim', 'Tense', 'Hopeful', 'Dusty', 'Wired', 'Hollow', 'Feral', 'Dreamy', 'Hazy', 'Driving', 'Mournful', 'Restless', 'Electric', 'Quiet']
const TIME = ['Dawn', 'Morning', 'Noon', 'Afternoon', 'Dusk', 'Night', 'Small hours', 'Blackout', 'Dust storm']
const NOTE = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

/** The first number in a text, in cm ("1.8 m" reads as 180). */
function cmIn(s: string | undefined): number | null {
  const m = s?.match(/\d+(\.\d+)?/)
  if (!m) return null
  const n = parseFloat(m[0])
  return n < 3 ? Math.round(n * 100) : n
}

/** What a card's details become, filled in, and its new name if it gets
 *  one. `taken`: names not to use (nameKey), grown by any it hands out. */
export function fillCard(card: ProjectGroup, groups: ProjectGroup[], taken: Set<string>, rnd: Rnd = Math.random): { name?: string; details: CardDetail[] } {
  const type = cardTypeOf(card)
  const details = withTypeDetails(card.details, type)
  const rows = new Map(details.map(d => [d.name.trim().toLowerCase(), d]))
  const empty = (k: string) => { const d = rows.get(k); return !!d && !d.link && !d.value.trim() }
  const out = new Map<string, Partial<CardDetail>>()
  const put = (k: string, value: string) => { if (empty(k)) out.set(k, { value }) }
  const link = (k: string, to: ProjectGroup | undefined) => { if (to && empty(k)) out.set(k, { link: { card: to.id } }) }
  const others = (t: CardType) => groups.filter(g => g.id !== card.id && cardTypeOf(g) === t && g.cardType)

  if (type === 'character') {
    const said = rows.get('body')?.value.trim().toLowerCase()
    const body: Body = BODIES.find(b => said && b.toLowerCase().startsWith(said.slice(0, 4)))
      ?? (rnd() < 0.5 ? 'Human' : rnd() < 0.4 ? 'Hybrid' : rnd() < 0.6 ? 'Mutated' : 'Mechanical')
    const b = BUILD[body]
    const height = cmIn(rows.get('height')?.value) ?? int(rnd, ...b.height)
    put('id', pick(rnd, [`${L(rnd)}${L(rnd)}-${int(rnd, 1000, 9999)}`, `#${pad(int(rnd, 1, 99))}-${int(rnd, 100, 999)}`, `${L(rnd)}-${int(rnd, 1000, 9999)}-${L(rnd)}`]))
    put('licence', pick(rnd, LICENCE))
    put('body', body)
    put('age', String(int(rnd, ...b.age)))
    put('height', `${height} cm`)
    put('weight', `${Math.round(int(rnd, ...b.perM2) * (height / 100) ** 2)} kg`)
    put('role', pick(rnd, ROLE))
    put('stats', `Str ${int(rnd, ...b.str)} · Spd ${int(rnd, ...b.spd)} · Wits ${int(rnd, ...b.wits)}`)
  } else if (type === 'faction') {
    const places = others('location')
    if (places.length) link('territory', pick(rnd, places)); else put('territory', placeName(rnd))
    const rivals = others('faction')
    const rival = rivals.length ? pick(rnd, rivals) : undefined
    link('rivals', rival)
    const friends = rivals.filter(g => g !== rival)
    if (friends.length) link('allies', pick(rnd, friends))
  } else if (type === 'location') {
    const [building, floors] = pick(rnd, BUILDING)
    put('place', placeName(rnd))
    put('building', building)
    put('use', pick(rnd, USE))
    put('floors', String(int(rnd, ...floors)))
    put('basement', pick(rnd, BASEMENT))
  } else if (type === 'prop') {
    const typed = rows.get('kind')?.value.trim().toLowerCase()
    const k = KIND.find(x => typed && x.kind.toLowerCase() === typed) ?? pick(rnd, KIND)
    put('kind', k.kind)
    if (k.ammo) put('ammo', k.ammo)
    put('capacity', k.cap(rnd))
  } else if (type === 'audio') {
    put('artist', makeName('faction', new Set(), rnd))
    put('length', `${int(rnd, 2, 6)}:${pad(int(rnd, 0, 59))}`)
    put('tempo', `${int(rnd, 60, 170)} BPM`)
    put('key', `${pick(rnd, NOTE)} ${pick(rnd, ['major', 'minor', 'minor'])}`)
    put('mood', pick(rnd, MOOD))
  } else if (type === 'scene') {
    put('act', String(int(rnd, 1, 3)))
    const places = others('location')
    if (places.length) link('location', pick(rnd, places)); else put('location', placeName(rnd))
    put('time of day', pick(rnd, TIME))
    put('mood', pick(rnd, MOOD))
  }

  const kind = nameKindOf(type)
  return {
    ...(kind && placeholderName(card.name) ? { name: makeName(kind, taken, rnd) } : {}),
    details: details.map(d => { const p = out.get(d.name.trim().toLowerCase()); return p ? { ...d, ...p } : d }),
  }
}
