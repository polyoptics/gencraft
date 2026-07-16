// useViewStatus.ts — React bridge to a viewport window's GL runtime state
// (loading/ready/error + first-render flag). Mirrors useResolvedMedia's
// module-cache + useSyncExternalStore pattern; keeps transient GL state
// out of the persisted store.

import { useSyncExternalStore, useCallback } from 'react'
import { subscribeViewStatus, getViewStatusSnapshot } from '../three/viewportRenderer'

export function useViewStatus(id: string) {
  const subscribe = useCallback((cb: () => void) => subscribeViewStatus(id, cb), [id])
  const getSnapshot = useCallback(() => getViewStatusSnapshot(id), [id])
  return useSyncExternalStore(subscribe, getSnapshot)
}
