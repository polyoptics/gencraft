#!/usr/bin/env node
// vidbars-mcp.mjs — the connector Claude uses to work in VidBars (Brian
// 2026-11-10).
//
// A local MCP server, started by the Claude app on this PC (stdio). It runs
// under the Claude plan already signed in: it holds no key, calls no model
// and no outside service. All it does is pass three requests to the open
// VidBars window (POST /api/agent on the dev server, vite.config.ts →
// src/utils/agentDoor.ts): list cards, read cards, deal a deck of NEW cards.
// There is no request that edits, moves or deletes what is on the canvas.
//
// No packages: the protocol is small enough to speak by hand.

import readline from 'node:readline'

const PORT = Number(process.env.VIDBARS_PORT || 5173)
const URL_ = process.env.VIDBARS_URL || `http://localhost:${PORT}`

const CARD_TYPES = ['element', 'character', 'faction', 'family', 'location', 'prop', 'audio', 'scene', 'prompt', 'note']

const TOOLS = [
  {
    name: 'list_cards',
    description: 'List the cards on the open VidBars canvas, briefly: id, name, type, a little of their text, and which are selected. Read-only. Use it to find the cards to read; "this card" or "these" usually means the selected ones.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: CARD_TYPES, description: 'Only cards of this type.' },
        search: { type: 'string', description: 'Only cards whose name or text contains this.' },
        selectedOnly: { type: 'boolean', description: 'Only the cards selected in VidBars right now.' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_cards',
    description: 'Read cards in full: name, type, header, text, the details on their back, the cards they link to, and for a faction, family or scene its members, ties or sections. Pictures are given by file name only. Read-only. With no ids, reads the cards selected in VidBars.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Card ids from list_cards. Empty: the selected cards.' } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'deal_deck',
    description: 'Deal NEW cards onto the VidBars canvas as one closed deck in an empty spot of the view, for the artist to flip through, keep or delete. This is the only way to change the canvas: existing cards cannot be edited, moved, linked or deleted, so put every suggestion (a fix for a continuity break, a new name, a shot) on a new card and say on it which card it is about. One undo removes the whole deal. Keep a deal to what was asked for; at most 40 cards.',
    inputSchema: {
      type: 'object',
      required: ['cards'],
      properties: {
        cards: {
          type: 'array', minItems: 1, maxItems: 40,
          items: {
            type: 'object',
            required: ['name'],
            properties: {
              name: { type: 'string', description: 'The card\'s name; also the header on its face unless header is given.' },
              header: { type: 'string', description: 'The header on its face, when it should differ from the name.' },
              text: { type: 'string', description: 'The words on its face. Short: a card, not a page.' },
              type: { type: 'string', enum: CARD_TYPES, description: 'Its type; gives it that type\'s colour and detail rows. Leave out for a plain card.' },
              details: {
                type: 'array', description: 'Rows for its back, e.g. a character\'s Age or Role. A row named like one of its type\'s own rows fills that row.',
                items: { type: 'object', required: ['name', 'value'], properties: { name: { type: 'string' }, value: { type: 'string' } } },
              },
            },
          },
        },
      },
    },
  },
]

const OPS = { list_cards: 'list', read_cards: 'read', deal_deck: 'deal' }

async function ask(op, args) {
  let res
  try {
    res = await fetch(`${URL_}/api/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-VidBars-Agent': '1' },
      body: JSON.stringify({ op, args }),
    })
  } catch {
    throw new Error('VidBars is not running. Ask the artist to start VidBars, then try again.')
  }
  const body = await res.json().catch(() => null)
  if (!body) throw new Error(`VidBars gave no answer (${res.status}). It may need a restart to pick up the connector.`)
  if (!body.ok) throw new Error(body.error || 'VidBars could not do that.')
  return body.result
}

const out = msg => process.stdout.write(JSON.stringify(msg) + '\n')

async function handle(msg) {
  const { id, method, params } = msg
  if (id === undefined) return // a notification: nothing to answer
  const ok = result => out({ jsonrpc: '2.0', id, result })
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'vidbars', version: '1.0.0' },
        instructions: 'VidBars is the artist\'s card canvas. You may read cards and deal NEW cards as a deck; you can never change what is already there. Read before you deal, keep card text short, and tell the artist plainly what you dealt.',
      })
    case 'ping': return ok({})
    case 'tools/list': return ok({ tools: TOOLS })
    case 'tools/call': {
      const op = OPS[params?.name]
      if (!op) return out({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${params?.name}` } })
      try {
        const result = await ask(op, params.arguments ?? {})
        return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] })
      } catch (e) {
        return ok({ content: [{ type: 'text', text: e.message }], isError: true })
      }
    }
    default:
      return out({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', line => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  void handle(msg)
})
