// MakeCardsButton — shown while image tiles are selected: turns them into
// cards, with tiles from the same source closing into a deck (utils/snipCards).

import React from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import { useUndoCoordinator } from '../../store/undoCoordinator'
import { canBecomeCard, tilesToCards } from '../../utils/snipCards'
import { expandTileIds } from '../../utils/tileDecks'

export const MakeCardsButton: React.FC = () => {
  const count = useFreeNodeStore(s =>
    expandTileIds(s.selectedIds, s.nodes).filter(id => canBecomeCard(s.nodes[id])).length)
  if (count === 0) return null
  const make = () => {
    const fs = useFreeNodeStore.getState()
    useUndoCoordinator.getState().checkpoint()
    const fronts = tilesToCards(fs.selectedIds)
    fs.clearFreeSelection()
    useBoardsStore.getState().setSelectedGroups(fronts)
  }
  return (
    <button
      onPointerDown={e => e.stopPropagation()}
      onClick={make}
      title="Turn the selected pictures into cards. Snips of the same picture close into one deck."
      style={{
        position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 1000,
        padding: '8px 14px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
        fontSize: 13, fontWeight: 600, color: '#fff',
        background: 'rgba(20,22,38,0.95)', border: '1px solid rgba(160,200,255,0.6)',
      }}
    >Make {count === 1 ? 'a card' : `${count} cards`}</button>
  )
}
