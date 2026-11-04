// Names for cards (Brian 2026-11-04): made up on the spot, in a sci-fi
// apocalypse street slang with funky spellings, and never the same name
// twice: not one any card has, nor one handed out before (the project's
// used-name list, boardsStore.usedNames). Built from parts, so the pool
// runs to many thousands. Brian's own examples are community names, so
// they, and respellings of them, are never made.

export type NameKind = 'character' | 'faction' | 'location' | 'prop'

type Rnd = () => number
const pick = <T,>(rnd: Rnd, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length]
const int = (rnd: Rnd, lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1))

// ── Parts ──────────────────────────────────────────────────────────────

/** First words: what the wasteland is made of, and what hums in it. */
const GRIT = ['Rad', 'Chrome', 'Glitch', 'Static', 'Rust', 'Ion', 'Flux', 'Servo', 'Null', 'Volt', 'Grit', 'Ash', 'Soot',
  'Neon', 'Scrap', 'Dust', 'Cinder', 'Hex', 'Byte', 'Sludge', 'Fizz', 'Rot', 'Salt', 'Tin', 'Wire', 'Torch', 'Drift',
  'Ozone', 'Jolt', 'Blight', 'Smog', 'Lumen', 'Gamma', 'Cobalt', 'Plasma', 'Slag', 'Signal', 'Rivet', 'Fuse', 'Carbon',
  'Glow', 'Sulfur', 'Diode', 'Copper', 'Lithium', 'Hazard', 'Brine', 'Fallow', 'Feral', 'Hollow']
/** Second words: critters, body bits and bolts. */
const BITS = ['Jaw', 'Fang', 'Rat', 'Moth', 'Wick', 'Socket', 'Tooth', 'Cog', 'Spoke', 'Lung', 'Vane', 'Hook', 'Shank',
  'Crank', 'Tusk', 'Gill', 'Beak', 'Knuckle', 'Spine', 'Rib', 'Lamp', 'Drum', 'Crow', 'Mantis', 'Hound', 'Jackal',
  'Wasp', 'Gecko', 'Tick', 'Lark', 'Mule', 'Grub', 'Beetle', 'Hornet', 'Shard', 'Sprocket', 'Gasket', 'Piston', 'Valve',
  'Antenna', 'Magpie', 'Possum', 'Buzzard', 'Ferret', 'Eel', 'Gopher', 'Wren', 'Skink', 'Badger', 'Locust']
/** Handles that stand alone. */
const SOLO = ['Sprocket', 'Static', 'Rivet', 'Cinder', 'Gutter', 'Socket', 'Crank', 'Gasket', 'Ozone', 'Diode', 'Kilowatt',
  'Ratchet', 'Torque', 'Rebar', 'Nickel', 'Jinx', 'Bingo', 'Domino', 'Sundown', 'Blister', 'Smudge', 'Tinker', 'Patches',
  'Scraps', 'Bootleg', 'Halfpint', 'Rooster', 'Fizzle', 'Grommet', 'Clank', 'Sputter', 'Gloom', 'Wraith', 'Morrow',
  'Quarter', 'Lantern', 'Hazmat', 'Sparks', 'Murk', 'Pylon', 'Relay', 'Ballast', 'Vector', 'Zero', 'Glitch',
  'Thimble', 'Drizzle', 'Molasses', 'Tumble']
/** Call signs that take a number. */
const UNIT = ['Kog', 'Vex', 'Dex', 'Zed', 'Hix', 'Rook', 'Tek', 'Nix', 'Ozo', 'Sol', 'Kix', 'Pyx', 'Lux', 'Fenn', 'Arc',
  'Ion', 'Kilo', 'Unit', 'Volt', 'Rho', 'Sigma', 'Fritz', 'Jax', 'Moxx', 'Quill', 'Rivv', 'Tock', 'Vox', 'Wex', 'Zink']
/** What goes in front of a handle. */
const TITLE = ['Lil', 'Big', "Ol'", 'Doc', 'Sister', 'Mama', 'Papa', 'Kid', 'Sarge', "Cap'n", 'Granny', 'Mister',
  'Saint', 'Brother', 'Auntie', 'Deacon', 'Boss', 'Lady', 'Baby', 'Professor']

const CREW = ['Saints', 'Choir', 'Kult', 'Krew', 'Syndikate', 'Union', 'Court', 'Pack', 'Tribe', 'Circus', 'Collective',
  'Congregation', 'Sisterhood', 'Riders', 'Jackals', 'Wardens', 'Prophets', 'Hounds', 'Rats', 'Kings', 'Widows',
  'Orphans', 'Mechanics', 'Lamplighters', 'Ghosts', 'Static', 'Cartel', 'Junta', 'Mob', 'Assembly',
  'Remnant', 'Chapter', 'Line', 'Order', 'Guild', 'Herd', 'Swarm', 'Fleet', 'Signal']
const CREED = ['the Dial', 'the Reactor', 'the Static', 'the Signal', 'Ozone', 'Rust', 'Gamma', 'the Long Dark',
  'Neon', 'the Last Grid', 'the Burn', 'the Wire', 'the Ash', 'the Drowned Sun', 'Kilowatt', 'the Dead Channel',
  'the Hum', 'the Glow', 'the Old Battery', 'the Sixth Fire', 'the Undertow', 'the Salt']

const PLACE_MOD = ['Rust', 'Glass', 'Ash', 'Salt', 'Neon', 'Chrome', 'Static', 'Rad', 'Cinder', 'Drowned', 'Burnt',
  'Sunk', 'Last', 'Low', 'Dead', 'Hollow', 'Ozone', 'Gamma', 'Signal', 'Smog', 'Slag', 'Scrap', 'Dust', 'Sulfur',
  'Copper', 'Busted', 'Bleak', 'Fuse', 'Coil', 'Grid']
const PLACE = ['Hollow', 'Gulch', 'Flats', 'Town', 'Ridge', 'Yard', 'Pit', 'Station', 'Crossing', 'Junction', 'Basin',
  'Mall', 'Wells', 'Springs', 'Heights', 'Bend', 'Row', 'Market', 'Spire', 'Dome', 'Stack', 'Reach', 'Sprawl',
  'Terminal', 'Locks', 'Sinks', 'Ditch', 'Pylons', 'Quarter', 'Gate']
const PLACE_THE = ['Sump', 'Drain', 'Silo', 'Spillway', 'Underpass', 'Tank', 'Dome', 'Overpass', 'Hive', 'Kiln',
  'Furnace', 'Grid', 'Cistern', 'Mainframe', 'Reactor', 'Dish', 'Sprawl', 'Boneyard', 'Gutterline', 'Coldstack',
  'Pumphouse', 'Switchyard', 'Crater', 'Hangar', 'Vats']
const PLACE_NUM = ['Sector', 'Camp', 'Exit', 'Mile', 'Block', 'Hab', 'Silo', 'Dome', 'Gate', 'Pier', 'Shaft', 'Lot']

const GEAR = ['Kicker', 'Spitter', 'Sparker', 'Buzzer', 'Zapper', 'Popper', 'Shredder', 'Screamer', 'Whisper',
  'Lullaby', 'Sermon', 'Verdict', 'Handshake', 'Last Call', 'Second Opinion', 'Bad Idea', 'Nightlight', 'Persuader',
  'Thunderjug', 'Rattler', 'Crackle', 'Ticker', 'Stinger', 'Grinder', 'Bellringer', 'Doorknocker', 'Goodnight']
const GEAR_MOD = ['Rad', 'Volt', 'Static', 'Rust', 'Chrome', 'Sweet', 'Lil', 'Big', "Ol'", 'Mean', 'Lucky', 'Dirty',
  'Quiet', 'Hot', 'Cold', 'Neon', 'Gamma', 'Ion', 'Junk', 'Holy']

// ── Funky spelling ─────────────────────────────────────────────────────

/** One respelling, street style: Krank, Statik, Sokkit, Cindah, Rivvit. */
const RESPELL: [RegExp, string | ((m: string) => string)][] = [
  [/ck/, 'kk'],
  [/^C(?=[aoulr])/, 'K'],
  [/^Ch(?=r)/, 'K'],
  [/er$/, 'ah'],
  [/ic$/, 'ik'],
  [/et$/, 'it'],
  [/s$/, 'z'],
  [/ight/, 'ite'],
  [/ph/, 'f'],
  [/qu/, 'kw'],
  [/x$/, 'xx'],
  [/oo/, 'u'],
  [/(?<=[a-z])o(?=[a-z])/, '0'],
  [/(?<=[^aeiou])y$/, 'ee'],
  [/^([A-Z][a-z][bdgmnprt])$/, (m: string) => m + m.slice(-1) + 'o'],
]
function funky(word: string, rnd: Rnd): string {
  const fits = RESPELL.filter(([re]) => re.test(word))
  if (!fits.length) return word
  const [re, to] = pick(rnd, fits)
  return word.replace(re, to as string)
}
/** Each word, now and then, respelled. */
const street = (words: string[], rnd: Rnd, odds = 0.4) => words.map(w => (rnd() < odds ? funky(w, rnd) : w)).join(' ')

// ── Never these ────────────────────────────────────────────────────────

/** A name's bones: its consonants, the way they sound, so a respelling of
 *  a name reads as that name. */
function bones(s: string): string {
  let t = s.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't')
  t = t.replace(/[^a-z]/g, '')
  const lead = t.startsWith('y') ? 'y' : ''
  t = t.replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/c/g, 'k').replace(/q/g, 'k').replace(/x/g, 'ks').replace(/z/g, 's')
  t = (lead + t.slice(lead.length)).replace(/(?!^)[aeiouy]/g, '').replace(/^[aeiou]/, '')
  return t.replace(/(.)\1+/g, '$1')
}
/** Brian's examples (2026-11-04): names from his community, not ours. */
const NOT_OURS = ['Pocket Knife', 'Money Pit', 'Mayhem', 'Yep', 'Tacoma'].map(bones)
const ours = (name: string) => { const b = bones(name); return !NOT_OURS.some(n => b.includes(n)) }

/** How a name is compared for "the same name": case and spaces aside. */
export const nameKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')

// ── Makers ─────────────────────────────────────────────────────────────

const MAKE: Record<NameKind, (rnd: Rnd) => string> = {
  character: rnd => {
    const r = rnd()
    if (r < 0.38) return street([pick(rnd, GRIT), pick(rnd, BITS)], rnd)
    if (r < 0.6) return funky(pick(rnd, SOLO), rnd)
    if (r < 0.78) return `${pick(rnd, UNIT)}${pick(rnd, ['', '-', '-', ' '])}${rnd() < 0.3 ? '0' + int(rnd, 1, 9) : int(rnd, 2, 99)}`
    return `${pick(rnd, TITLE)} ${street([rnd() < 0.5 ? pick(rnd, SOLO) : pick(rnd, BITS)], rnd, 0.5)}`
  },
  faction: rnd => {
    const r = rnd()
    if (r < 0.5) return `The ${pick(rnd, [...GRIT, ...PLACE_MOD])} ${pick(rnd, CREW)}`
    if (r < 0.75) return `${pick(rnd, ['Sons', 'Daughters', 'Children', 'Keepers', 'Saints', 'Widows', 'Heirs'])} of ${pick(rnd, CREED)}`
    return `${street([pick(rnd, GRIT)], rnd, 0.5)} ${pick(rnd, ['Kult', 'Krew', 'Born', 'Mob', 'Syndikate', 'Kartel', 'Klub', 'Kommune'])}`
  },
  location: rnd => {
    const r = rnd()
    if (r < 0.5) return street([pick(rnd, PLACE_MOD), pick(rnd, PLACE)], rnd, 0.25)
    if (r < 0.75) return `The ${pick(rnd, PLACE_THE)}`
    return `${pick(rnd, PLACE_NUM)} ${int(rnd, 2, 99)}`
  },
  prop: rnd => {
    const r = rnd()
    if (r < 0.6) return `${pick(rnd, GEAR_MOD)} ${pick(rnd, GEAR)}`
    return street([pick(rnd, GEAR)], rnd, 0.7)
  },
}

/** A new name of this kind, not in `taken` (keys from nameKey), and added
 *  to it. */
export function makeName(kind: NameKind, taken: Set<string>, rnd: Rnd = Math.random): string {
  for (let i = 0; i < 400; i++) {
    const n = MAKE[kind](rnd).replace(/\s+/g, ' ').trim()
    if (!ours(n) || taken.has(nameKey(n))) continue
    taken.add(nameKey(n))
    return n
  }
  // Thousands taken: a number on the end keeps it new.
  for (let k = 2; ; k++) {
    const n = `${MAKE[kind](rnd)} ${k}`
    if (ours(n) && !taken.has(nameKey(n))) { taken.add(nameKey(n)); return n }
  }
}

/** A place name for a detail (not a card's name, so it may come again). */
export const placeName = (rnd: Rnd = Math.random) => MAKE.location(rnd)
export { pick, int }
