// poolStore.ts — what each Media Pool is currently showing.
//
// Transient by design: a directory listing is cheap to re-fetch and goes
// stale the moment someone touches the folder, so only the DIRECTORY is
// persisted (on the node, as `poolDir`) and the contents are re-read on
// mount. What matters is that the contents live somewhere SHARED rather
// than inside the component, because that is how a magneted Rolodex can
// browse a pool without the two components knowing about each other.

import { create } from 'zustand'
import { recordHistory } from './historyStore'

export interface PoolFile {
  /** Stable within a listing: the url doubles as the identity. */
  id: string
  name: string
  url: string
  kind: 'image' | 'video' | 'audio' | 'model'
  size: number
}

export interface PoolDir {
  name: string
  path: string
}

export interface PoolContents {
  dir: string
  parent: string
  dirs: PoolDir[]
  files: PoolFile[]
  loading: boolean
  error?: string
}

const EMPTY: PoolContents = { dir: '', parent: '', dirs: [], files: [], loading: false }

interface PoolStore {
  pools: Record<string, PoolContents>
  setLoading: (nodeId: string, dir: string) => void
  setContents: (nodeId: string, c: Omit<PoolContents, 'loading'>) => void
  setError: (nodeId: string, error: string) => void
  drop: (nodeId: string) => void
}

export const usePoolStore = create<PoolStore>((set) => ({
  pools: {},
  setLoading: (nodeId, dir) => set(s => ({
    pools: { ...s.pools, [nodeId]: { ...(s.pools[nodeId] ?? EMPTY), dir, loading: true, error: undefined } },
  })),
  setContents: (nodeId, c) => set(s => ({
    pools: { ...s.pools, [nodeId]: { ...c, loading: false } },
  })),
  setError: (nodeId, error) => set(s => ({
    pools: { ...s.pools, [nodeId]: { ...(s.pools[nodeId] ?? EMPTY), loading: false, error } },
  })),
  drop: (nodeId) => set(s => {
    const { [nodeId]: _, ...rest } = s.pools
    return { pools: rest }
  }),
}))

export function getPoolContents(nodeId: string): PoolContents {
  return usePoolStore.getState().pools[nodeId] ?? EMPTY
}

/** Read a directory through the dev-server browse endpoint. */
export async function loadPoolDir(nodeId: string, dir: string): Promise<void> {
  const st = usePoolStore.getState()
  st.setLoading(nodeId, dir)
  try {
    const res = await fetch(`/api/browse?dir=${encodeURIComponent(dir)}`)
    const json = await res.json()
    if (json.error) { st.setError(nodeId, json.error); return }
    st.setContents(nodeId, {
      dir: json.dir,
      parent: json.parent,
      dirs: json.dirs ?? [],
      files: (json.files ?? []).map((f: Omit<PoolFile, 'id'>) => ({ ...f, id: f.url })),
    })
    // Where you have BEEN is history, so a History window docked to a pool
    // can walk you back. Recorded after success only: a folder that failed
    // to read is not somewhere you went.
    recordHistory({
      kind: 'folder', sourceId: nodeId, dir: json.dir,
      label: json.dir,
    })
  } catch (err) {
    st.setError(nodeId, String(err))
  }
}
