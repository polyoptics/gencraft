// modelMaps.ts — a model's colour maps as pictures, and pictures back onto
// a model as its colour maps (Brian 2026-11-15).
//
// A model card on a loop strip is read as the pictures its surfaces carry:
// one per colour map, in the order the model holds them (`slot`). The strip
// processes them like any picture, and what it makes lands as a result card
// tied to the model's card (ProjectGroup.mapOf, utils/modelGrade). Wherever
// that model is then drawn, its instance wears the result in place of the
// map it came with (gradeLook). The model's file and its card are never
// changed: take the result card away and the model is as it came.
//
// Slots are counted the same way here and in modelLook's createLook (the
// distinct `map` textures in traversal order), so a picture read from slot
// 2 goes back onto slot 2 on every instance.

import * as THREE from 'three'
import { create } from 'zustand'
import { acquireModel, releaseModel, disposeInstance } from './modelCache'
import { resolveMediaUrl } from '../utils/useResolvedMedia'
import type { LookInstance } from './modelLook'

export interface ColorMap {
  /** Which of the model's colour maps, counted in traversal order. */
  slot: number
  /** The picture, as a data: url. */
  url: string
  /** The material it is on (the first, when several share it). */
  name: string
  w: number
  h: number
}

/** The colour maps read so far, by model url. `version` moves when one
 *  lands, for what shows them (the loop strip). */
export const useModelMaps = create<{ maps: Record<string, ColorMap[]>; version: number }>(() => ({ maps: {}, version: 0 }))

const reading = new Set<string>()

/** Each distinct colour map under `root`, in traversal order, with the name
 *  of the first material that carries it. */
export function mapSlots(root: THREE.Object3D): { tex: THREE.Texture; name: string }[] {
  const out: { tex: THREE.Texture; name: string }[] = []
  const seen = new Set<THREE.Texture>()
  root.traverse(o => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      const tex = (m as THREE.MeshStandardMaterial | undefined)?.map
      if (!tex || seen.has(tex)) continue
      seen.add(tex)
      out.push({ tex, name: m.name || mesh.name || '' })
    }
  })
  return out
}

type Drawable = HTMLImageElement | HTMLCanvasElement | ImageBitmap

/** A texture's picture as a data: url (generated media must be data: urls,
 *  CLAUDE.md §6), or null when it holds none that can be read. */
function pictureOf(tex: THREE.Texture): { url: string; w: number; h: number } | null {
  const img = tex.image as Drawable | undefined
  if (!img) return null
  const w = (img as HTMLImageElement).naturalWidth || img.width, h = (img as HTMLImageElement).naturalHeight || img.height
  if (!w || !h) return null
  const src = (img as HTMLImageElement).src
  if (typeof src === 'string' && src.startsWith('data:image/')) return { url: src, w, h }
  try {
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    c.getContext('2d')!.drawImage(img, 0, 0)
    const url = c.toDataURL('image/png')
    c.width = c.height = 0
    return url.length > 64 ? { url, w, h } : null
  } catch { return null }
}

/** A model's colour maps as pictures. Null while they are being read (the
 *  store's `version` moves when they land); an empty list for a model that
 *  carries none. */
export function colorMapsOf(url: string): ColorMap[] | null {
  const have = useModelMaps.getState().maps[url]
  if (have) return have
  if (reading.has(url)) return null
  reading.add(url)
  const land = (maps: ColorMap[]) => {
    reading.delete(url)
    useModelMaps.setState(s => ({ maps: { ...s.maps, [url]: maps }, version: s.version + 1 }))
  }
  acquireModel(url).then(async root => {
    try {
      // A texture's picture can still be decoding when the model lands.
      const slots = mapSlots(root)
      await Promise.all(slots.map(s => (s.tex.image as HTMLImageElement | undefined)?.decode?.().catch(() => undefined)))
      const maps: ColorMap[] = []
      slots.forEach((s, slot) => {
        const pic = pictureOf(s.tex)
        if (pic) maps.push({ slot, name: s.name, ...pic })
      })
      land(maps)
    } finally {
      disposeInstance(root)
      releaseModel(url)
    }
  }).catch(() => land([]))
  return null
}

/** Pictures to wear in place of a model's colour maps: by slot, the stored
 *  url of each. `sig` names the set, so an instance is only redressed when
 *  it changes. */
export interface Grade { sig: string; bySlot: Record<number, string> }

/** Where the 3D views ask what a model wears, and hear that it changed.
 *  Filled in by utils/modelGrade (startModelGrade), which reads the cards:
 *  the views stay free of the stores. */
export const grades: { for: (key: string | null, url: string) => Grade | null; changed: Set<() => void> } = { for: () => null, changed: new Set() }

// A graded map as a texture: the model's own map with the new picture in
// it, so it sits on the surface exactly as the map it replaces. A few are
// kept; one let go is uploaded again if it is ever shown again.
const textures = new Map<string, Promise<THREE.Texture | null>>()
const KEEP = 24

function gradedTexture(orig: THREE.Texture, url: string, cutout: boolean): Promise<THREE.Texture | null> {
  const key = `${orig.uuid}|${cutout ? 1 : 0}|${url}`
  const hit = textures.get(key)
  if (hit) { textures.delete(key); textures.set(key, hit); return hit }
  const p = (async (): Promise<THREE.Texture | null> => {
    try {
      const src = await resolveMediaUrl(url)
      if (!src) return null
      const img = new Image()
      img.decoding = 'async'
      img.src = src
      await img.decode()
      if (!img.naturalWidth) return null
      let picture: Drawable = img
      const was = orig.image as Drawable | undefined
      if (cutout && was) {
        // A result is saved without transparency: where the model's own map
        // was see-through (leaves, hair), the new one is cut the same way.
        const c = document.createElement('canvas')
        c.width = img.naturalWidth; c.height = img.naturalHeight
        const g = c.getContext('2d')!
        g.drawImage(img, 0, 0)
        g.globalCompositeOperation = 'destination-in'
        g.drawImage(was, 0, 0, c.width, c.height)
        picture = c
      }
      const tex = orig.clone()
      tex.image = picture
      tex.needsUpdate = true
      return tex
    } catch { return null }
  })()
  textures.set(key, p)
  void p.then(t => { if (!t && textures.get(key) === p) textures.delete(key) })
  while (textures.size > KEEP) {
    const [old, gone] = textures.entries().next().value!
    textures.delete(old)
    void gone.then(t => t?.dispose())
  }
  return p
}

/** Dress an instance in `grade` (null: the maps it came with). Cheap when
 *  nothing changed, so it can be called every frame; `changed` is called
 *  when a picture lands later and the instance should be drawn again. */
export function gradeLook(look: LookInstance, grade: Grade | null, changed?: () => void): void {
  const sig = grade?.sig ?? ''
  if (look.gradeSig === sig) return
  look.gradeSig = sig
  for (const [m, orig] of look.maps) {
    const mat = m as THREE.MeshStandardMaterial
    const slot = orig ? look.slotOf.get(orig) : undefined
    const url = slot === undefined ? undefined : grade?.bySlot[slot]
    const set = (tex: THREE.Texture | null) => {
      if (mat.map === tex) return
      const shape = !mat.map !== !tex
      mat.map = tex
      if (shape) mat.needsUpdate = true
    }
    if (!url || !orig) { set(orig); continue }
    const cutout = mat.transparent || mat.alphaTest > 0
    void gradedTexture(orig, url, cutout).then(tex => {
      if (look.gradeSig !== sig) return
      set(tex ?? orig)
      changed?.()
    })
  }
}
