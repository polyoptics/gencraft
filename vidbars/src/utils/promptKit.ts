// promptKit.ts — the editable contents of a Prompt Pad.
//
// A pad is a workshop for BUILDING prompts, so its vocabulary belongs to
// the person using it: sections and tags are all editable, and the whole
// kit lives on the node so two pads can carry different vocabularies (one
// for characters, one for environments) and travel with export/undo.

export interface PromptTag {
  id: string
  text: string
}

export interface PromptSection {
  id: string
  label: string
  collapsed?: boolean
  tags: PromptTag[]
}

export interface SavedPrompt {
  id: string
  label: string
  text: string
  savedAt: number
}

export interface PromptKit {
  sections: PromptSection[]
  saved: SavedPrompt[]
}

const uid = () => crypto.randomUUID()

function section(label: string, tags: string[]): PromptSection {
  return { id: uid(), label, tags: tags.map(t => ({ id: uid(), text: t })) }
}

/** Starting vocabulary — the categories from the design, as a starting
 *  point to edit rather than a fixed menu. */
export function defaultPromptKit(): PromptKit {
  return {
    sections: [
      section('framing', ['isometric view', 'orthographic view', 'front, back, left, right', 'arms out to the side', '3/4 view']),
      section('grids', ['2x2 grid', '3x3 grid', 'where each cell contains', 'sprite sheet']),
      section('isolation', ['clean black background', 'clean white background', 'transparent background', 'no shadow']),
      section('style matching', ['in the same style as the reference images', 'flat vector', 'painterly', 'photoreal', 'blueprint']),
      section('for 3d generation', ['T-pose', 'neutral pose', 'even lighting', 'texture atlas', 'seamless']),
    ],
    saved: [],
  }
}

export function newSection(label = 'new section'): PromptSection {
  return { id: uid(), label, tags: [] }
}

export function newTag(text: string): PromptTag {
  return { id: uid(), text }
}

export function newSaved(text: string, label?: string): SavedPrompt {
  const first = text.split('\n').map(s => s.trim()).find(Boolean) ?? ''
  return {
    id: uid(),
    label: label?.trim() || (first.length > 46 ? `${first.slice(0, 46)}…` : first) || 'untitled',
    text,
    savedAt: Date.now(),
  }
}
