#!/usr/bin/env node
// vidbars-mcp.mjs — the connector Claude uses to work in VidBars (Brian
// 2026-11-10).
//
// A local MCP server, started by the Claude app on this PC (stdio). It runs
// under the Claude plan already signed in: it holds no key, calls no model
// and no outside service. All it does is pass three requests to the open
// VidBars window (POST /api/agent on the dev server, vite.config.ts →
// src/utils/agentDoor.ts): list cards and decks, read cards, hand out the
// media on cards as files, and deal a deck of cards (new ones, results
// brought in from outside, and linked cards of ones that are there).
//
// Brian 2026-11-18: widened so references and elements can go out of
// VidBars to another tool (send_file posts a card's file to an upload
// address that tool gave) and the result can come back as a card
// (deal_deck takes a file or a web address).
//
// No packages: the protocol is small enough to speak by hand.

import readline from 'node:readline'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UPLOADS = path.resolve(HERE, '..', 'public', 'uploads')
// Files handed out that live inside the VidBars window, not on disk.
const HANDOUT = path.join(os.tmpdir(), 'vidbars-agent')
// Where send_file may post to: host names (and their sub-domains), comma
// separated. "*" for anywhere.
const SEND_HOSTS = (process.env.VIDBARS_SEND_HOSTS || 'krea.ai').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)
const MAX_FETCH = 1024 * 1024 * 1024

const PORT = Number(process.env.VIDBARS_PORT || 5173)
const URL_ = process.env.VIDBARS_URL || `http://localhost:${PORT}`

const CARD_TYPES = ['element', 'character', 'faction', 'family', 'location', 'prop', 'audio', 'scene', 'prompt', 'note']

const DOING = { type: 'string', description: 'A few words on what you are doing, shown to the artist in a bubble by your pointer in VidBars, e.g. "Reading the cast". Plain words, under ten.' }

// The same kinds /api/file serves (src/utils/diskUrl.ts SERVABLE).
const SERVABLE = /\.(png|jpe?g|jfif|webp|gif|avif|bmp|svg|ico|tiff?|heic|jxl|mp4|webm|mov|m4v|mkv|ogv|mp3|wav|ogg|oga|opus|m4a|aac|flac|glb|gltf|fbx|obj|bin|ktx2|tga|hdr|exr|dds)$/i
const kindOf = name => /\.(mp4|webm|mov|m4v|mkv|ogv)$/i.test(name) ? 'video'
  : /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac)$/i.test(name) ? 'audio'
  : /\.(glb|gltf|fbx|obj)$/i.test(name) ? 'model' : 'image'
const EXT_OF_MIME = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/avif': '.avif', 'image/svg+xml': '.svg',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg', 'audio/mp4': '.m4a', 'audio/flac': '.flac',
  'model/gltf-binary': '.glb', 'model/gltf+json': '.gltf',
}
const MIME_OF_EXT = Object.fromEntries(Object.entries(EXT_OF_MIME).map(([m, e]) => [e, m]))
const mimeOf = name => MIME_OF_EXT[path.extname(name).toLowerCase().replace('.jpeg', '.jpg')] || 'application/octet-stream'

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
    name: 'list_decks',
    description: 'List the decks on the open VidBars canvas: closed decks (stacked or fanned on their front card) and open decks (cards lying touching), each with its cards in order. A card on its own is not listed here; use list_cards. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Only decks holding a card whose name contains this.' },
        selectedOnly: { type: 'boolean', description: 'Only decks holding a card selected in VidBars right now.' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_cards',
    description: 'Read cards in full: name, type, header, text, the details on their back, the cards they link to, and for a faction, family or scene its members, ties or sections. Pictures are given by file name only; get_card_media hands out the files. Read-only. With no ids, reads the cards selected in VidBars.',
    inputSchema: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' }, description: 'Card ids from list_cards. Empty: the selected cards.' } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_card_media',
    description: 'Hand out the media on cards (pictures, movies, sounds, 3D models) as files on this computer: for each, its card, block, kind, name and file path. Use it to look at a picture, or to pass one on: send_file posts a handed-out file to an upload address. Read-only for VidBars. With no ids, the cards selected in VidBars.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Card ids from list_cards. Empty: the selected cards.' },
        kinds: { type: 'array', items: { type: 'string', enum: ['image', 'video', 'audio', 'model'] }, description: 'Only these kinds. Empty: all.' },
        look: { type: 'boolean', description: 'Also return the pictures themselves so you can see them (the first 8, when small enough).' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'send_file',
    description: 'Post one file handed out by get_card_media to an upload address another tool gave you (for example a presigned upload URL), as multipart/form-data, and return what the address answers (usually the uploaded file\'s web address). Only files get_card_media handed out in this session can be sent, and only to the hosts the artist allows. Use it when the artist asks for a card\'s picture or model to be used somewhere else.',
    inputSchema: {
      type: 'object',
      required: ['file', 'url'],
      properties: {
        file: { type: 'string', description: 'A file path exactly as get_card_media gave it.' },
        url: { type: 'string', description: 'The https upload address to post to.' },
        field: { type: 'string', description: 'The form field the file goes in. Default "file".' },
      },
    },
  },
  {
    name: 'deal_deck',
    description: 'Deal cards onto the VidBars canvas as one closed deck in an empty spot of the view, for the artist to flip through, keep or delete. A dealt card is one of: a NEW card of words; a NEW card holding media brought in from outside (a result: give media a web address or a file path, and from the ids of the cards it was made from); or a new LINKED card of a card that is already there (linkTo), which is that same card shown in a second place. One undo removes the whole deal. Keep a deal to what was asked for; at most 40 cards.',
    inputSchema: {
      type: 'object',
      required: ['cards'],
      properties: {
        cards: {
          type: 'array', minItems: 1, maxItems: 40,
          items: {
            type: 'object',
            properties: {
              linkTo: { type: 'string', description: 'The id of a card that is there: deal a linked card of it. Everything else on this entry is then left out.' },
              media: {
                type: 'array', description: 'Pictures, movies, sounds or 3D models to put on the new card, one block each. Each is a web address (it is downloaded and kept with VidBars) or a file on this computer (used where it is).',
                items: { type: 'object', properties: {
                  url: { type: 'string', description: 'An http(s) address of the file.' },
                  file: { type: 'string', description: 'The full path of a file on this computer.' },
                  name: { type: 'string', description: 'A name for it, when the address or path does not give a good one.' },
                } },
              },
              from: { type: 'array', items: { type: 'string' }, description: 'Ids of the cards this new card was made from: it is linked back to them.' },
              name: { type: 'string', description: 'The card\'s name; also the header on its face unless header is given. Needed unless linkTo is given.' },
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

for (const t of TOOLS) if (t.name !== 'send_file') t.inputSchema.properties.doing = DOING

const OPS = { list_cards: 'list', read_cards: 'read', list_decks: 'decks' }

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

// ── Media out: where the window says a file is kept → a path on disk ─────

/** Files handed out this session: the only ones send_file will post. */
const handedOut = new Set()

function fileOfKept(kept, name) {
  if (kept.path) return kept.path
  if (kept.upload) return path.join(UPLOADS, path.basename(kept.upload))
  if (kept.data) {
    const m = /^data:([^;,]*)(;base64)?,/.exec(kept.data)
    if (!m) return null
    const bytes = Buffer.from(kept.data.slice(m[0].length), m[2] ? 'base64' : 'utf8')
    const ext = (name && path.extname(name)) || EXT_OF_MIME[m[1]] || ''
    const base = (name ? path.basename(name, path.extname(name)) : 'media').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 60)
    const hash = crypto.createHash('sha1').update(bytes).digest('hex').slice(0, 10)
    fs.mkdirSync(HANDOUT, { recursive: true })
    const p = path.join(HANDOUT, `${base}-${hash}${ext}`)
    if (!fs.existsSync(p)) fs.writeFileSync(p, bytes)
    return p
  }
  return null
}

async function getCardMedia(args) {
  const res = await ask('media', { ids: args.ids, kinds: args.kinds, doing: args.doing })
  const content = []
  let looks = 0
  const media = res.media.map(m => {
    const { kept, ...rest } = m
    const file = fileOfKept(kept, m.name)
    if (file && fs.existsSync(file)) {
      handedOut.add(path.resolve(file))
      if (args.look && m.type === 'image' && looks < 8) {
        const mime = mimeOf(file)
        if (/^image\/(png|jpeg|webp|gif)$/.test(mime) && fs.statSync(file).size <= 4 * 1024 * 1024) {
          content.push({ type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: mime })
          looks++
        }
      }
      return { ...rest, file }
    }
    if (kept.url) return { ...rest, url: kept.url }
    return { ...rest, unavailable: kept.tooBig ? 'Too large to hand out from inside VidBars.' : 'Its file could not be found.' }
  })
  const result = { count: media.length, media, ...(res.notFound ? { notFound: res.notFound } : {}) }
  return [{ type: 'text', text: JSON.stringify(result, null, 1) }, ...content]
}

async function sendFile(args) {
  const file = path.resolve(String(args.file ?? ''))
  if (!handedOut.has(file)) throw new Error('Only a file get_card_media handed out in this session can be sent. Call get_card_media first and use the path it gives.')
  let url
  try { url = new URL(String(args.url ?? '')) } catch { throw new Error('That is not a web address.') }
  if (url.protocol !== 'https:') throw new Error('Only https addresses can be posted to.')
  const host = url.hostname.toLowerCase()
  if (!SEND_HOSTS.includes('*') && !SEND_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
    throw new Error(`Sending to ${host} is not allowed. Allowed: ${SEND_HOSTS.join(', ')}. The artist can allow more with VIDBARS_SEND_HOSTS in the connector's settings.`)
  }
  const form = new FormData()
  form.append(typeof args.field === 'string' && args.field ? args.field : 'file',
    new Blob([fs.readFileSync(file)], { type: mimeOf(file) }), path.basename(file))
  const res = await fetch(url, { method: 'POST', body: form })
  const text = (await res.text()).slice(0, 4000)
  if (!res.ok) throw new Error(`The address answered ${res.status}: ${text}`)
  return [{ type: 'text', text: text || `Sent (${res.status}).` }]
}

// ── Media in: a web address or a file → a url the VidBars window serves ──

// The same encoding as src/utils/diskUrl.ts.
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())

async function bringIn(m) {
  if (typeof m.file === 'string' && m.file) {
    const p = path.resolve(m.file)
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error(`No file at ${m.file}.`)
    if (!SERVABLE.test(p)) throw new Error(`VidBars cannot show that kind of file: ${path.basename(p)}.`)
    const st = fs.statSync(p)
    const v = `${st.size.toString(36)}-${Math.round(st.mtimeMs).toString(36)}`
    return { url: `/api/file?v=${enc(v)}&path=${enc(p)}`, type: kindOf(p), name: m.name || path.basename(p) }
  }
  if (typeof m.url === 'string' && /^https?:\/\//i.test(m.url)) {
    let res
    try { res = await fetch(m.url) } catch { throw new Error(`Could not reach ${m.url}.`) }
    if (!res.ok) throw new Error(`${m.url} answered ${res.status}.`)
    if (Number(res.headers.get('content-length') || 0) > MAX_FETCH) throw new Error('That file is too large to bring in.')
    const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
    let base = ''
    try { base = decodeURIComponent(path.basename(new URL(res.url || m.url).pathname)) } catch { /* no name in the address */ }
    let name = (typeof m.name === 'string' && m.name) || base || 'result'
    if (!SERVABLE.test(name)) name += (SERVABLE.test(base) ? path.extname(base) : EXT_OF_MIME[mime] || '')
    if (!SERVABLE.test(name)) throw new Error(`VidBars cannot show that kind of file (${mime || 'unknown kind'}) from ${m.url}.`)
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length > MAX_FETCH) throw new Error('That file is too large to bring in.')
    const disk = `${crypto.randomUUID().slice(0, 8)}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    fs.mkdirSync(UPLOADS, { recursive: true })
    fs.writeFileSync(path.join(UPLOADS, disk), bytes)
    return { url: `/uploads/${disk}`, type: kindOf(name), name }
  }
  throw new Error('Each media entry needs a url (http or https) or a file path.')
}

async function dealDeck(args) {
  const cards = []
  for (const c of Array.isArray(args.cards) ? args.cards : []) {
    const media = []
    for (const m of Array.isArray(c.media) ? c.media : []) media.push(await bringIn(m))
    cards.push({ ...c, media })
  }
  const result = await ask('deal', { ...args, cards })
  return [{ type: 'text', text: JSON.stringify(result, null, 1) }]
}

const LOCAL = { get_card_media: getCardMedia, send_file: sendFile, deal_deck: dealDeck }

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
        serverInfo: { name: 'vidbars', version: '1.1.0' },
        instructions: 'VidBars is the artist\'s card canvas. You may read cards and decks, hand out the media on cards as files, and deal a deck of cards: new cards, results brought in from another tool, and linked cards of cards that are there. Read before you deal, keep card text short, and tell the artist plainly what you dealt. The artist sees your pointer in VidBars with a bubble: give each request a few plain words in "doing". To use a card\'s picture or model with another tool, get_card_media then send_file to the upload address that tool gives; bring what comes back onto a card with deal_deck (media, and from: the cards it was made from).',
      })
    case 'ping': return ok({})
    case 'tools/list': return ok({ tools: TOOLS })
    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      if (!OPS[name] && !LOCAL[name]) return out({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } })
      try {
        const content = LOCAL[name]
          ? await LOCAL[name](args)
          : [{ type: 'text', text: JSON.stringify(await ask(OPS[name], args), null, 1) }]
        return ok({ content })
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
