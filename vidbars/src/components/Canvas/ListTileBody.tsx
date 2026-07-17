// ListTileBody.tsx — the body of a pinned LIST tile: a live, compact view
// of the query's current results (header = query summary, up to 8 rows of
// thumb + name, "+N more" footer). Results recompute from the stores on
// every change — the query is LIVE by construction. Rows are
// non-interactive in v1 (the tile stays a clean drag surface).

import React, { useMemo } from 'react'
import { useBoardsStore } from '../../store/boardsStore'
import { useFreeNodeStore } from '../../store/freeNodeStore'
import type { FreeNodeData } from '../../store/freeNodeStore'
import { evaluateListQuery } from '../../utils/listQueryEval'
import { formatListQuerySummary } from '../../utils/contentKinds'
import { getFirstImageUrl } from '../../types/bar'
import { getModelPoster } from '../../three/posterService'
import { useResolvedMedia } from '../../utils/useResolvedMedia'

const MAX_ROWS = 8

interface ListRow {
  key: string
  name: string
  color: string
  thumb: string | null
}

export const ListTileBody: React.FC<{ node: FreeNodeData; dz: number }> = ({ node, dz }) => {
  const groups = useBoardsStore(s => s.groups)
  const boards = useBoardsStore(s => s.boards)
  const nodes = useFreeNodeStore(s => s.nodes)

  const rows = useMemo<{ list: ListRow[]; total: number }>(() => {
    const q = node.listQuery
    if (!q) return { list: [], total: 0 }
    const res = evaluateListQuery(q, groups, boards, nodes)
    const list: ListRow[] = []
    for (const g of res.groups) {
      let thumb: string | null = g.cardHeroImage ?? null
      if (!thumb) {
        for (const bid of g.boardIds) {
          const board = boards[bid]
          if (!board) continue
          for (const rid of board.rootIds) {
            thumb = getFirstImageUrl(board.bars[rid]?.content)
            if (thumb) break
          }
          if (thumb) break
        }
      }
      list.push({ key: 'g:' + g.id, name: g.name || 'Untitled', color: g.color, thumb })
    }
    for (const n of res.freeNodes) {
      const thumb = n.type === 'model'
        ? (n.posterUrl ?? (n.imageUrl ? getModelPoster(n.imageUrl) : null))
        : (n.type === 'image' || n.type === 'video') ? n.imageUrl : null
      list.push({ key: 'n:' + n.id, name: n.label || 'Untitled', color: n.color, thumb })
    }
    return { list: list.slice(0, MAX_ROWS), total: list.length }
  }, [node.listQuery, groups, boards, nodes])

  const summary = node.listQuery ? formatListQuerySummary(node.listQuery) : 'List'

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', pointerEvents: 'none' }}>
      <div style={{
        padding: `${5 * dz}px ${8 * dz}px`,
        fontSize: 9.5 * dz, fontWeight: 700, letterSpacing: '0.4px',
        color: 'rgba(160,200,255,0.85)',
        borderBottom: `${Math.max(1, dz)}px solid rgba(255,255,255,0.08)`,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>≔ {summary}</div>
      <div style={{ flex: 1, overflow: 'hidden', padding: `${3 * dz}px 0` }}>
        {rows.list.map(r => <ListRowView key={r.key} row={r} dz={dz} />)}
        {rows.total === 0 && (
          <div style={{ padding: `${8 * dz}px`, fontSize: 9 * dz, color: 'rgba(255,255,255,0.3)' }}>
            no matches
          </div>
        )}
      </div>
      <div style={{
        padding: `${3 * dz}px ${8 * dz}px`,
        fontSize: 8.5 * dz, color: 'rgba(255,255,255,0.35)',
        borderTop: `${Math.max(1, dz)}px solid rgba(255,255,255,0.06)`,
      }}>
        {rows.total > rows.list.length ? `+${rows.total - rows.list.length} more · ` : ''}{rows.total} item{rows.total === 1 ? '' : 's'}
      </div>
    </div>
  )
}

const ListRowView: React.FC<{ row: ListRow; dz: number }> = ({ row, dz }) => {
  const thumb = useResolvedMedia(row.thumb)
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6 * dz,
      padding: `${2.5 * dz}px ${8 * dz}px`,
    }}>
      {thumb ? (
        <img src={thumb} draggable={false} style={{
          width: 18 * dz, height: 14 * dz, objectFit: 'cover',
          borderRadius: 2 * dz, flexShrink: 0,
        }} />
      ) : (
        <div style={{
          width: 18 * dz, height: 14 * dz, borderRadius: 2 * dz, flexShrink: 0,
          background: row.color, opacity: 0.8,
        }} />
      )}
      <span style={{
        fontSize: 9 * dz, color: 'rgba(255,255,255,0.75)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>{row.name}</span>
    </div>
  )
}
