// paramHelp.ts — what each value on an effect card means, in plain words.
//
// Shown when the mouse rests on a value's row (EffectTileBody). Each line
// says what the value is and what you see change when you move it, for
// someone looking at the picture, not at the code. The drawing cards' lines
// follow the film tools' own notes on their dials (sketchLook tools_scale
// look_*.py), so they say what the tool really does with the number.
//
// A value with no line here shows its name alone.

import type { EffectKind } from './effects'

/** Values several drawing cards share, said once. */
const SHOW = 'What the card shows. Over picture: the drawing laid on the picture. Alone: only the drawing, so you can see exactly what this card adds.'
const LOOK_STRENGTH = 'How strongly the drawing shows over the picture. 0 hides it, 1 is as drawn, higher pushes it harder. Changes at once, nothing is redrawn.'
const SEED = 'A different roll of the dice. Every number gives the same drawing with its strokes, breaks and wobble placed differently. Nothing gets stronger or weaker: try another number when one stroke lands badly.'
const BOIL = 'On a clip, how many frames each drawing is held before it is drawn afresh. 1 is a new drawing every frame (busy, shimmering lines). 2 is "on twos", the usual hand-drawn feel. Higher is calmer and steppier. Does nothing on a single picture.'
const WHERE = 'Which part gets the marks: the figure (what a Segment card finds), the background behind it, or both.'

const HELP: Partial<Record<EffectKind, Record<string, string>>> = {
  bloom: {
    threshold: 'How bright an area has to be before it glows. Lower: more of the picture glows. Higher: only the brightest highlights do.',
    strength: 'How bright the glow is.',
    radius: 'How far the glow spills out from the bright areas. Low is a tight halo, high is a wide soft haze.',
  },
  glare: {
    threshold: 'How bright a spot has to be before it throws rays. Lower: more spots get stars. Higher: only the brightest points.',
    length: 'How long the rays reach out from each highlight.',
    strength: 'How bright the rays are.',
    rays: 'How many rays each star has.',
    angle: 'Turns the whole star, in degrees.',
  },
  glow: {
    strength: 'How much of the soft haze is laid over the picture. 0 is none.',
    spread: 'How far the haze blurs out. Low keeps it close to the shapes, high makes everything dreamy.',
  },
  ink: {
    threshold: 'How strong an edge has to be before it gets an ink line. Lower: more lines, down to fine detail. Higher: only the boldest edges.',
    weight: 'How thick the ink lines are.',
    paper: 'Fades the picture under the lines toward blank paper. 0 keeps the picture, 1 leaves only lines on paper.',
    amount: 'How dark the ink lines are. 0 hides them.',
  },
  cel: {
    levels: 'How many flat steps of light and dark the colour is cut into. Fewer bands look more like a cartoon, more bands look smoother.',
    saturation: 'How vivid the flat colours are. 0 is grey, 1 is as the picture, higher is punchier.',
    lines: 'How dark the outlines round the shapes are. 0 is no outlines.',
  },
  sketch: {
    radius: 'How soft and broad the pencil shading is. Low gives thin, crisp lines, high gives wide smudgy shading.',
    darkness: 'How hard the pencil is pressed. Higher makes the lines and shading darker.',
    color: 'How much of the picture\'s colour stays in the drawing. 0 is a grey pencil drawing, 1 keeps full colour.',
  },
  halftone: {
    cell: 'How big the printed dots are. Small dots read as smooth tone, big dots read as comic-book print.',
    angle: 'Turns the rows of dots, in degrees.',
    amount: 'How much the dots replace the picture. 0 is the picture untouched, 1 is all dots.',
  },
  chroma: {
    amount: 'How far the colours split apart toward the edges of the picture, the red and blue fringes of a cheap lens. 0 is none.',
  },
  grade: {
    exposure: 'Makes the whole picture brighter or darker, like opening or closing the lens. 0 leaves it alone.',
    contrast: 'How far apart the lights and darks are pushed. Below 1 is flatter and greyer, above 1 is punchier.',
    saturation: 'How vivid the colours are. 0 is black and white, 1 is as the picture, higher is richer.',
    hue: 'Which colour the tint is, going round the colour wheel (0 red, 120 green, 240 blue). Only shows when Tint is above 0.',
    tint: 'How much of the tint colour is washed over the picture. 0 is none.',
  },
  multiply: { mix: 'How much of the next picture is mixed in. It can only darken: white in it changes nothing. 0 is this picture alone.' },
  screen: { mix: 'How much of the next picture is mixed in. It can only lighten: black in it changes nothing. 0 is this picture alone.' },
  overlay: { mix: 'How much of the next picture is mixed in. Its lights lighten and its darks darken, for a punchier result. 0 is this picture alone.' },
  depth: {
    far: 'Which way round the grey map is. 0: near things are bright and far things dark. 1: far things are bright.',
  },
  segment: {
    cut: 'What the card passes on. 0: it only marks what it found, for the cards after it to draw on. 1: it cuts the picture down to what it found and drops the rest.',
    engine: 'Which finder looks for the things you name. SAM 3 understands descriptions ("the man in the yellow jacket") and follows them through a clip. DINO + SAM2 is the older finder, for when SAM 3 misses or is not installed.',
    ref: 'The size on screen, in pixels, at which the drawing cards\' strokes look right as they are set. Something found bigger than this is drawn with bolder, wider-spaced strokes, something smaller with finer ones. Raise it if everything is drawn too heavy, lower it if too fine.',
    lo: 'The finest the strokes are ever allowed to get. A very small or far-off figure stops shrinking its strokes at this share of full size, so its lines do not turn to mush.',
    spacing_follow: 'How much the gap between hatching lines follows the size of the thing. 0: the same spacing on a small figure as on a big one. 1: spacing shrinks fully with it. In between is gentler.',
  },
  filmline: {
    show: 'Which part of the drawing the card shows. All: everything over the picture. Outline, Inside or Pencil: that one layer alone on white, to see what it is doing.',
    contour_w: 'How thick the brush outline round the figure is.',
    detail: 'How much line work is drawn inside the figure: folds, features, edges of shapes. 0 is almost none, 1 is busy.',
    interior_w: 'How thick the lines inside the figure are.',
    rough: 'How much red pencil is under the ink: heavier strokes, pressed harder. 0 is none.',
    rough_opacity: 'How strongly the red pencil shows at its darkest.',
    wobble: 'How much the lines wander off true, like an unsteady hand. 0 is a clean, exact line.',
    dry: 'How much the brush runs dry: streaks and broken texture, most at the tails of strokes. 0 is solid ink.',
    breaks: 'How much of each line is left out as small tapered gaps. 0 is unbroken lines.',
    restroke: 'A second, thinner, looser stroke drawn along the outline, as if the line was searched for twice. 0 turns it off, 1 is as strong as it gets.',
    seed: SEED,
    boil: BOIL,
  },
  linemix: {
    strength: 'How strongly all the lines of the Film outline before this card show. 0 hides them, 1 is as drawn. Changes at once, nothing is redrawn.',
    pencil: 'How strongly the red pencil layer shows. 0 hides it, 1 is as drawn.',
    ink: 'How strongly the black ink layers (outline and inside lines) show. 0 hides them, 1 is as drawn.',
    weight: 'Makes the lines thicker or thinner without redrawing. 1 is as drawn.',
    dark: 'Makes the ink darker or lighter. 0 is as drawn, above deepens it, below lifts it toward grey.',
    tint: 'Pulls the ink away from black toward a deep version of the colour underneath it. 0 is black ink, 1 is fully coloured lines.',
    light: 'How strongly the light lines drawn on dark areas show. 0 hides them, 1 is as drawn.',
  },
  formhatch: {
    show: SHOW,
    spacing: 'The gap between hatching lines. Small is dense and dark, large is open and airy.',
    weight: 'How thick the strokes are in full shadow. Strokes in lighter shadow are thinner than this.',
    angle: 'Which way the strokes lean before the form bends them, in degrees up from flat. 0 is level, 90 is upright.',
    wrap: 'How much the strokes curve round the body\'s form. 0 is straight parallel lines, higher bows them round arms, faces and folds.',
    tone1: 'How deep a shadow has to be before hatching starts. Lower: strokes creep out into the lighter half-tones, so more of the figure is hatched. Higher: only the deeper shadows get strokes.',
    dark_lum: 'Colours darker than this get no dark hatching (on black hair or a dark coat it only turns to mud). 0 hatches everything, higher leaves more of the dark areas clean.',
    'default.cross': 'How much a second set of strokes crosses the first in the deepest shadows and creases. 0 is none.',
    'default.light': 'Sparse light strokes on the side facing the light, like chalk highlights. 0 is none.',
    light_az: 'Which side the light comes from, in degrees round the picture. 0 is from the right, 90 from above, 180 from the left, 270 from below. The shadows, and so the hatching, fall on the other side.',
    stroke_px: 'How long each stroke runs before the pen lifts. Short reads as quick ticks, long as sweeping lines.',
    seed: SEED,
    boil: BOIL,
  },
  bghatch: {
    show: SHOW,
    spacing: 'The gap between hatching lines. Small is dense and dark, large is open and airy.',
    weight: 'How thick the strokes are in a deep shadow.',
    opacity: 'How dark the strokes are on the nearest part of the background.',
    far_opacity: 'How dark the strokes are in the far distance. Lower than "Ink, near" makes the hatching fade as things get further away.',
    far_cut: 'How far off the hatching gives up altogether. 0 hatches right to the horizon, higher leaves more of the far distance bare.',
    paint_hi: 'How dark the painting has to be, against its lit areas, before it counts as a shadow to hatch. Higher: more of the background counts as shadow. Lower: only the darkest shapes.',
    cross: 'How much a second set of strokes crosses the first in the nearest, deepest shadows. 0 is none.',
    pencil: 'Draws the far shapes in red pencil instead of ink, this strongly. 0 keeps them in ink.',
    stroke_px: 'How long each stroke runs before the pen lifts.',
    seed: SEED,
    boil: BOIL,
  },
  shademix: {
    hatch: 'How strongly the hatching on the figure shows. 0 hides it, 1 is as drawn. Changes at once, nothing is redrawn.',
    bg: 'How strongly the hatching on the background shows. 0 hides it, 1 is as drawn.',
    hatch_weight: 'Makes the figure\'s strokes thicker or thinner without redrawing. 1 is as drawn.',
    bg_weight: 'Makes the background\'s strokes thicker or thinner without redrawing. 1 is as drawn.',
    hatch_dark: 'Makes the figure\'s hatching ink darker or lighter. 0 is as drawn.',
    bg_dark: 'Makes the background\'s hatching ink darker or lighter. 0 is as drawn.',
    light: 'How strongly the light strokes show. 0 hides them, 1 is as drawn.',
    stipple: 'How strongly a Stipple card before this one shows. 0 hides it, 1 is as drawn.',
    halftone: 'How strongly a Halftone card before this one shows. 0 hides it, 1 is as drawn.',
  },
  painthatch: {
    spacing: 'The gap between strokes where the shadow is lightest. Deeper shadow is hatched closer than this.',
    width: 'How thick a stroke is at full pressure.',
    angle: 'The hand\'s natural hatching angle, in degrees up from flat. 0 is level, 90 is upright.',
    form: 'How much the strokes bend to follow the form instead of all leaning one way. 0 keeps every stroke at the Angle.',
    cross: 'How much a second set of strokes crosses the first. 0 is none.',
    length: 'How long the strokes are where the shadow is lightest.',
    drop: 'How much darker than the lit colour an area has to be painted before it counts as full shadow. Lower: faint painted shading is already hatched heavily. Higher: only strong shadows are.',
  },
  filmcel: {
    light_deg: 'Which side the light comes from, in degrees round the picture. 0 is from the right, 90 from above, 180 from the left. The shadow shapes fall on the other side.',
    terminator: 'How much of the figure is in shadow. Higher moves the shadow edge toward the light, so more of the form goes dark.',
    flatten: 'How flat the shadows are. 1: one designed shadow tone, like a cel. 0: the shadow is laid over the painting\'s own shading, which still shows through.',
    hatch: 'Feathered strokes that soften the shadow edge out into the light. 0 is a hard edge.',
    cast: 'Shadows the figure throws on itself, an arm across the chest, a hand on what it holds. 0 is none.',
    agree: 'How much the shadow shapes follow the shading already painted in the picture, instead of only the new light. 0 ignores the painting.',
    jitter_px: 'How much the shadow edge wanders, like a hand-painted cel. 0 is a clean edge.',
  },
  boilink: {
    weight_lit: 'How thick the line is on edges facing the light.',
    weight_shadow: 'How thick the line is on edges facing away from the light. Much heavier than the lit side gives the look its weight.',
    light_deg: 'Which side the light comes from, in degrees round the picture. 0 is from the right, 90 from above, 135 from the upper left. The heavy line falls on the other side.',
    texture: 'How much the brush runs dry and streaky. 0 is solid ink.',
    stroke_len: 'How long each brush stroke runs before the next one starts.',
    lost_edges: 'How often the line breaks off on the lit side and picks up again, a lost-and-found edge. 0 is an unbroken line.',
    wobble: 'How much each stroke wavers along its length.',
  },
  misreg: {
    weight: 'How thick the line is.',
    offset: 'How far the line sits off the figure, like a print where the line plate has slipped.',
    off_deg: 'Which way the line has slipped, in degrees. 0 is to the right, 90 is down, 180 to the left, 270 up.',
    gap: 'How often a stroke is left out altogether, mostly on the lit side. 0 is a complete line.',
    dry: 'How much the brush runs dry and streaky through the stroke. 0 is solid ink.',
    stroke_len: 'How long each stroke runs before the next one starts.',
    tremor: 'How much the hand shakes along each stroke, and how badly one stroke lines up with the next.',
  },
  construction: {
    weight: 'How thick the main pencil stroke is.',
    passes: 'How many lighter strokes go over each edge on top of the main one, as if searching for the line.',
    pass_spread: 'How far those searching strokes drift to either side of the main line. Higher looks looser and more sketched.',
    overshoot: 'How far each stroke runs on past where the edge ends, the way a quick construction line shoots through a corner.',
    construction: 'How many faint guide lines are struck across the figure. 0 is none.',
    tone: 'How dark the pencil gets at its heaviest.',
    grain: 'How much the paper\'s tooth breaks up the pencil. 0 is smooth, 1 is very broken and grainy.',
  },
  relight: {
    key_deg: 'Which side the main light comes from, in degrees round the picture.',
    key_elev: 'How high the main light sits. Low rakes across the surface and shows more form, high is flatter, from overhead.',
    key: 'How much surfaces turned toward the main light are brightened.',
    shadow: 'How much surfaces turned away from the main light are darkened.',
    rim: 'How bright the light from behind is, the thin bright edge round the figure.',
    spec: 'How shiny surfaces are: the strength of the bright glints.',
    ao: 'How dark the creases and places where things touch get.',
    haze: 'How much the background is veiled, so the figure stands off it.',
    respect: 'How much the light already painted in the picture holds the new light back. 0 lights it as if the painting had none. 1 leaves already-lit painting almost alone.',
  },
  formlight: {
    rim: 'How bright the light from behind is, the bright edge round the form.',
    shadow: 'How strong the shadow is that wraps round the side away from the light.',
    glint: 'How strong the small bright glints are.',
    depth: 'How round the form is taken to be. 1 is fully round, lower is flatter, with thinner rims of light.',
    env: 'How much the rim light takes its brightness from what is just behind the edge. Higher: bright against a bright backdrop, dim against a dark one.',
    rim_spread: 'How far round the form the back light still catches, in degrees. Low is a thin sliver, high wraps a long way round.',
  },
  bglayout: {
    far_ratio: 'How far into the distance the drawing reaches before it has faded to nothing. Higher draws further back.',
    busy: 'How much crowded areas (a city, rubble, foliage) are calmed down instead of every edge being drawn. 0 draws them all.',
    horizon: 'How strongly the skyline is still drawn, however far away it is. 0 lets it fade like everything else.',
    halo: 'How wide a clear gap the background lines leave round the figure.',
    hi: 'How strong an edge has to be before it is drawn at all. Lower: more lines, finer detail. Higher: only the main shapes.',
  },
  combine: {
    strength: 'How strongly the look rows are laid over the picture. 0 is the picture alone, 1 is the looks in full.',
  },
  stipple: {
    where: WHERE,
    ink: 'How dark each dot is.',
    dot: 'How big the dots are.',
    dark: 'How densely the dots are packed for a given shadow. Higher makes the whole stippling read darker.',
    edge: 'Extra dots gathered along edges, to hold the shapes. 0 is none.',
    form: 'How much the dots gather where the surface turns away from the light, so they model the form instead of lying as a flat tint. 0 is flat.',
    jitter: 'How unevenly the dots are placed, the looseness of the hand. 0 is very regular.',
    shiver: 'On a clip, how much the dots shift from drawing to drawing. 0 holds them still.',
  },
  halftoneshade: {
    where: WHERE,
    cell: 'How big the printed dots and the gaps between them are.',
    ink: 'How dark the dots are.',
    angle: 'Turns the rows of dots, in degrees.',
    form: 'How much the dots swell where the surface turns away from the light and shrink where it turns toward it, so they model the form. 0 is a flat tone.',
    drift: 'On a clip, how much the dot screen slips from drawing to drawing, like a reprinted frame a little out of register. 0 holds it still.',
  },
  bgwash: {
    haze: 'How much the far distance fades toward the haze colour, losing its contrast.',
    wash: 'How strong the cool shadow wash is on the near ground.',
    core: 'A darker accent where the shadow is deepest. 0 is none.',
    shade_hi: 'How dark the painting has to be, against its lit areas, before it counts as shadow and takes the wash. Higher: more of the background is washed.',
    grain: 'How much the wash settles into the paper\'s grain, darker in the hollows. 0 is an even wash.',
    mottle: 'Broad uneven patches in the wash, as pigment pools. 0 is even.',
  },
}

/** What value `key` on a `kind` card means, or '' when there is no line. */
export function paramHelp(kind: EffectKind, key: string): string {
  // A Segment card's rows for each thing it found.
  if (key.startsWith('scale:')) {
    return `How big "${key.slice(6)}" is taken to be, which sets how bold or fine the drawing cards draw it. Auto uses the size measured in the picture. Any other value fixes it by hand: 1 is full size, bold strokes, smaller is finer.`
  }
  if (key.startsWith('view:')) {
    return `Raise this when only part of "${key.slice(5)}" is in the picture (a head and shoulders, say). It tells the card the whole thing is this many times bigger than what shows, so it is not drawn too fine. 1 means all of it is in view.`
  }
  const own = HELP[kind]?.[key]
  if (own) return own
  // The drawing looks share these (effects.ts lookDef).
  if (key === 'show') return SHOW
  if (key === 'strength') return LOOK_STRENGTH
  if (key === 'seed') return SEED
  if (key === 'boil') return BOIL
  return ''
}
