// mediaStore.ts — local IndexedDB blob store for media bytes
// (images / video posters / etc.). Lives in its OWN database
// (`vidbars-media`) so it can never interfere with the persistence-
// critical `vidbars-zustand` DB or its version/upgrade path. The
// project state holds `mediaref:<id>` pointers (see mediaRef.ts); the
// actual bytes live here as native Blobs.

import type { StorageWriteFailedDetail } from './debouncedJSONStorage'

const DB_NAME = 'vidbars-media'
const STORE_NAME = 'blobs'

interface MediaRecord {
  blob: Blob
  type: string
  size: number
  createdAt: number
}

// Lazy singleton connection, mirroring debouncedIDBStorage's pattern.
let dbPromise: Promise<IDBDatabase> | null = null
function openAt(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('media IDB open blocked — another tab is upgrading'))
  })
}
function getDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = (async () => {
    // Versionless open: creates at v1 (firing onupgradeneeded) if absent,
    // otherwise opens at whatever version exists — never VersionErrors.
    let db = await openAt()
    // Self-heal: a DB can exist WITHOUT the object store (crashed or
    // interrupted first open). Existing-DB opens skip onupgradeneeded,
    // so force an upgrade to create it.
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      const bumped = db.version + 1
      db.close()
      db = await openAt(bumped)
    }
    return db
  })()
  dbPromise.catch(() => { dbPromise = null })
  return dbPromise
}

/** Surface a write failure via the same window event the persistence
 *  banner already listens for (quota errors, disk-full, etc.). */
function surfaceFailure(err: unknown): void {
  const e = err as { name?: string; message?: string } | null
  const detail: StorageWriteFailedDetail = {
    key: 'vidbars-media',
    errorName: e?.name ?? 'Error',
    errorMessage: e?.message ?? String(err),
    isQuotaExceeded: e?.name === 'QuotaExceededError',
    payloadBytes: 0,
    totalLocalStorageBytes: 0,
    timestamp: Date.now(),
  }
  try { window.dispatchEvent(new CustomEvent('storage-write-failed', { detail })) } catch { /* ignore */ }
}

/** Store a Blob and return its new id. Throws on failure so the caller
 *  can decide a fallback (e.g. keep a data URL). */
export async function putMedia(blob: Blob): Promise<string> {
  const id = crypto.randomUUID()
  const rec: MediaRecord = { blob, type: blob.type, size: blob.size, createdAt: Date.now() }
  try {
    const db = await getDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(rec, id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('media tx aborted'))
    })
    return id
  } catch (err) {
    surfaceFailure(err)
    throw err
  }
}

/** Store a Blob under a SPECIFIC id (used by import so the manifest's
 *  `mediaref:<id>` pointers keep matching their bytes). Overwrites any
 *  existing record at that id. */
export async function putMediaWithId(id: string, blob: Blob): Promise<void> {
  const rec: MediaRecord = { blob, type: blob.type, size: blob.size, createdAt: Date.now() }
  try {
    const db = await getDB()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(rec, id)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error ?? new Error('media tx aborted'))
    })
  } catch (err) {
    surfaceFailure(err)
    throw err
  }
}

/** Load a Blob by id, or null if absent / on error. */
export async function getMedia(id: string): Promise<Blob | null> {
  try {
    const db = await getDB()
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(id)
      req.onsuccess = () => resolve((req.result as MediaRecord | undefined)?.blob ?? null)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return null
  }
}

export async function hasMedia(id: string): Promise<boolean> {
  try {
    const db = await getDB()
    return await new Promise<boolean>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).count(id)
      req.onsuccess = () => resolve(req.result > 0)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return false
  }
}

export async function listMediaIds(): Promise<string[]> {
  try {
    const db = await getDB()
    return await new Promise<string[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).getAllKeys()
      req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String))
      req.onerror = () => reject(req.error)
    })
  } catch {
    return []
  }
}

export async function deleteMedia(id: string): Promise<void> {
  const db = await getDB()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** Delete every stored blob whose id is NOT in `referenced`.
 *  Returns the count removed. Not auto-run — deletion is the riskiest
 *  op, wired manually/after soak. */
export async function gcOrphans(referenced: Set<string>): Promise<number> {
  const ids = await listMediaIds()
  let removed = 0
  for (const id of ids) {
    if (!referenced.has(id)) { await deleteMedia(id); removed++ }
  }
  return removed
}
