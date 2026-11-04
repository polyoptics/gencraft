// Card details: the back of a card (Brian 2026-11-04). Flip a card over
// and its back is its DETAILS side: a list of name / value rows, e.g. a
// character's licence or a building's floors, that other cards and tools
// can read by name.

/** One row on a card's details side. */
export interface CardDetail {
  id: string
  name: string
  value: string
}

let seq = 0
export function newDetailId(): string {
  seq = (seq + 1) % 1e6
  return `d${Date.now().toString(36)}${seq.toString(36)}`
}
