#!/usr/bin/env node
// vidbars-mcp.mjs — the connector Claude uses to work in VidBars (Brian
// 2026-11-10).
//
// A local MCP server, started by the Claude app on this PC (stdio). It runs
// under the Claude plan already signed in: it holds no key, calls no model
// and no outside service. All it does is pass three requests to the open
// VidBars window (POST /api/agent on the dev server, vite.config.ts →
// src/utils/agentDoor.ts): list cards and decks, read cards, hand out the
// media on cards as files, deal a deck of cards (new ones, results brought
// in from outside, and linked cards of ones that are there), and, when the
// artist asks, change what is there (edit, arrange, decks, links, delete),
// one undo each; and use the tools: set one down, build a 3D set from
// cards, make a GIF or a movie, add cards to a Rough Cut.
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

const MEDIA_ENTRY = { type: 'object', description: 'A picture, movie, sound or 3D model: url (http or https) or file (a full path on this computer); for a 3D model, thumbnail (url or file) is the picture it shows.', properties: { url: { type: 'string' }, file: { type: 'string' }, name: { type: 'string' }, thumbnail: { type: 'object', properties: { url: { type: 'string' }, file: { type: 'string' } } } } }

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
        places: { type: 'boolean', description: 'Also say where each card lies on the canvas (x, y, w, h in canvas units), for arrange_cards.' },
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
                  thumbnail: { type: 'object', description: 'For a 3D model that came with a picture of itself (a preview or thumbnail from the tool that made it): that picture, as url or file. The model\'s card shows it as its face, and the model stands up from it in 3D. Give it here, NOT as a second media entry: a second entry makes a second board on the card.', properties: { url: { type: 'string' }, file: { type: 'string' } } },
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
  {
    name: 'edit_cards',
    description: 'Change cards that are already on the canvas: name, header, text, type, colour and how see-through it is, which side is up, what its face shows (one of its blocks, or a picture of its own), the detail rows on the back. Only what you give changes. What a card holds (its blocks) is changed with edit_blocks. Editing a linked card edits the card it shows, everywhere it is shown. Only when the artist asked for the change. One undo takes the whole edit back.',
    inputSchema: {
      type: 'object', required: ['cards'],
      properties: { cards: { type: 'array', minItems: 1, maxItems: 40, items: {
        type: 'object', required: ['id'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' }, header: { type: 'string' }, text: { type: 'string' },
          type: { type: 'string', enum: CARD_TYPES },
          color: { type: 'string', description: '#rrggbb' },
          opacity: { type: 'number', description: 'How solid its colour is, 0 (see-through) to 1.' },
          side: { type: 'string', enum: ['face', 'back'], description: 'Which side is up: the face, or the back with its detail rows.' },
          faceBlock: { type: 'string', description: 'The id of one of its blocks (read_cards): the face shows that block\'s picture, movie or model.' },
          picture: { type: ['object', 'null'], description: 'A picture of its own for the face, as url or file, in place of a block\'s; null takes it away again.', properties: { url: { type: 'string' }, file: { type: 'string' } } },
          details: { type: 'array', description: 'Rows for its back. A row named like one it has takes the new value; a new name adds a row; value null removes the row.',
            items: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, value: { type: ['string', 'null'] } } } },
        },
      } } },
    },
  },
  {
    name: 'arrange_cards',
    description: 'Move cards that are on the canvas into one touching row (an open deck), in the order given; with close, shut the row as a closed deck on the first card. Where: at (the row\'s top-left in canvas units, see list_cards places), beside (right of that card), or neither for an empty spot of the view. A card inside a closed deck is taken out of it; a closed deck named by its front card moves whole. Only when the artist asked. One undo takes it back.',
    inputSchema: {
      type: 'object', required: ['ids'],
      properties: {
        ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Card ids from list_cards.' },
        at: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
        beside: { type: 'string', description: 'A card id: the row starts touching its right side.' },
        close: { type: 'boolean', description: 'Shut the row as a closed deck.' },
      },
    },
  },
  {
    name: 'set_deck',
    description: 'Open a closed deck (state open: name any one card of it), or close cards as a deck (state stacked or fanned: name all its cards, the front card first; or one card of a deck that is already closed, to switch it). One undo takes it back.',
    inputSchema: {
      type: 'object', required: ['ids', 'state'],
      properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Card ids from list_cards.' }, state: { type: 'string', enum: ['open', 'stacked', 'fanned'] } },
    },
  },
  {
    name: 'link_cards',
    description: 'Link one card to others (the link is held by from and shows on both), or with remove, take those links away. This is a link between different cards; a linked card (the same card shown twice) is dealt with deal_deck linkTo. One undo takes it back.',
    inputSchema: {
      type: 'object', required: ['from', 'to'],
      properties: { from: { type: 'string' }, to: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Card ids from list_cards.' }, remove: { type: 'boolean' } },
    },
  },
  {
    name: 'delete_cards',
    description: 'Delete cards from the canvas. A closed deck named by its front card is deleted whole. Only when the artist plainly asked for these cards to be deleted; say which you deleted. One undo brings them back.',
    inputSchema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Card ids from list_cards.' } } },
    annotations: { destructiveHint: true },
  },
  {
    name: 'select_cards',
    description: 'Select cards in VidBars, so the artist sees which ones you mean. An empty list clears the selection. Changes nothing else.',
    inputSchema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' } } } },
  },
  {
    name: 'undo',
    description: 'Take back the last change on the canvas, exactly as the artist\'s Ctrl+Z: use it right after a change of yours that was wrong or that the artist does not want.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tools',
    description: 'List the tools set down on the VidBars canvas (Viewers, Rough Cuts, 3D sets, loop strips, Media Pools, Prompt Pads and the rest): id, type and where each lies. Read-only.',
    inputSchema: { type: 'object', properties: { type: { type: 'string', description: 'Only this type, as list_tools names it, e.g. "3D set", "roughCut", "viewer".' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'place_tool',
    description: 'Set one of VidBars\' tools down on the canvas, as its top-bar button does: in an empty spot of the view, or centred on at. One undo takes it away.',
    inputSchema: {
      type: 'object', required: ['tool'],
      properties: {
        tool: { type: 'string', enum: ['viewer', 'media_pool', 'prompt_pad', 'card_prompts', 'history', 'card_browser', 'attributes', 'film_look', 'rough_cut', 'storyline', 'cabinet', 'loop_strip', 'set_3d', 'states'] },
        at: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, description: 'Its middle, canvas units.' },
      },
    },
  },
  {
    name: 'make_3d_set',
    description: 'Build a 3D set from cards: a new 3D set with its own card in an empty spot of the view, and docked under it a new linked card of each card named, with each one\'s 3D model standing in the set where you say (or spread across the middle). The cards named are not moved. Only cards holding a 3D model stand in the set. Returns the set\'s id and the linked cards\' ids, which stand_in_3d_set takes to move them afterwards. The artist tilts the view to see it in 3D. One undo takes it all back.',
    inputSchema: {
      type: 'object', required: ['cards'],
      properties: {
        name: { type: 'string', description: 'A name for the set\'s card.' },
        cards: { type: 'array', maxItems: 40, items: { type: 'object', required: ['id'], properties: {
            id: { type: 'string', description: 'A card id from list_cards.' },
            x: { type: 'number', description: 'Across the ground, 0 (left) to 1 (right).' },
            y: { type: 'number', description: 'Deep into the ground, 0 (back, top of the set as seen flat) to 1 (front).' },
            height: { type: 'number', description: 'Lifted off the ground, as a part of the set\'s width. 0: standing on it.' },
            size: { type: 'number', description: 'How big, times its natural fit. 1: as it comes.' },
            turn: { type: 'number', description: 'Turned about upright, degrees.' },
          } } },
      },
    },
  },
  {
    name: 'stand_in_3d_set',
    description: 'Move, lift, size or turn models that stand in a 3D set. Only what you give changes. One undo takes it back.',
    inputSchema: {
      type: 'object', required: ['setId', 'cards'],
      properties: {
        setId: { type: 'string', description: 'The 3D set\'s id, from make_3d_set or list_tools.' },
        cards: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', required: ['id'], properties: {
            id: { type: 'string', description: 'The id of a linked card under the set (from make_3d_set).' },
            x: { type: 'number', description: 'Across the ground, 0 (left) to 1 (right).' },
            y: { type: 'number', description: 'Deep into the ground, 0 (back, top of the set as seen flat) to 1 (front).' },
            height: { type: 'number', description: 'Lifted off the ground, as a part of the set\'s width. 0: standing on it.' },
            size: { type: 'number', description: 'How big, times its natural fit. 1: as it comes.' },
            turn: { type: 'number', description: 'Turned about upright, degrees. 0 faces the front of the set (toward the viewer), 90 faces right.' },
            tip: { type: 'number', description: 'Tipped up (or, below 0, down), degrees.' },
            lookAt: { type: 'object', description: 'Face this spot of the set instead of turn and tip (a camera looks at it).', properties: { x: { type: 'number' }, y: { type: 'number' }, height: { type: 'number' } } },
            mm: { type: 'number', description: 'A camera\'s lens, millimetres.' },
            focus: { type: 'number', description: 'A camera\'s focal point, how far ahead in camera lengths.' },
          } } },
      },
    },
  },
  {
    name: 'make_gif',
    description: 'Make the movies and pictures on cards into one looping GIF, on a new card beside them, as the deck\'s right-click item does. A closed deck named by its front card gives every card in it. At least one card must hold a movie.',
    inputSchema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Card ids from list_cards.' }, pingPong: { type: 'boolean', description: 'Play forward then backward.' } } },
  },
  {
    name: 'make_movie',
    description: 'Join the shots on cards, in order, into one MP4 movie on a new card beside them (the desktop app only), as the deck\'s right-click item does. A closed deck named by its front card gives every card in it.',
    inputSchema: { type: 'object', required: ['ids'], properties: { ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Card ids from list_cards.' } } },
  },
  {
    name: 'add_to_rough_cut',
    description: 'Add the clips on cards to a Rough Cut, end to end after what it holds, in the order given. list_tools gives the Rough Cuts on the canvas; place_tool rough_cut makes one. One undo takes them out.',
    inputSchema: { type: 'object', required: ['toolId', 'ids'], properties: { toolId: { type: 'string' }, ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Card ids from list_cards.' } } },
  },
  {
    name: 'read_states',
    description: 'Read a States workspace (the visual state machine): every node with its kind, name, card, where it sits, whether it is lit or true, its number, and the names of its input and output ports; and every wire with what kind it is. list_tools gives the workspaces; place_tool states makes one. Read-only.',
    inputSchema: { type: 'object', required: ['toolId'], properties: { toolId: { type: 'string', description: 'The workspace\'s id, from list_tools.' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'build_states',
    description: 'Add nodes and wires to a States workspace, all in one undo. How it works: a state is a card (or a blank with a name); several states joined by change wires are one machine with one lit at a time. state → state is a CHANGE (an arrow); to say what makes that change happen, wire an event (or anything that happens) onto the change itself with toWire. A condition (a value with compare, and / or, calculate, is_in, a switch, a state with not) wired INTO a state HOLDS it lit while true. Events fire once; conditions are read all the time. Values: a wire into a value adds (does add, by n) or sets (does set, by n) when something happens; a wire OUT of a value carries compare and number. Gadgets (signal, switch, selector, counter, timer, dice, meter, calculate, send / receive, wait, pick_one, choose, show_hide) have named ports: read_states lists them. Give each new node a ref and use refs (or existing ids) in wires. Leave x and y out and nodes are laid in rows clear of what is there. Wires that cannot be made come back in notWired with the ports each end has.',
    inputSchema: {
      type: 'object', required: ['toolId'],
      properties: {
        toolId: { type: 'string' },
        nodes: { type: 'array', maxItems: 60, items: {
          type: 'object', required: ['kind'],
          properties: {
            ref: { type: 'string', description: 'Your own short name for it, used in wires of this request.' },
            kind: { type: 'string', enum: ['state', 'any', 'event', 'pick_one', 'value', 'and', 'or', 'is_in', 'calculate', 'signal', 'switch', 'selector', 'counter', 'timer', 'dice', 'meter', 'send', 'receive', 'wait', 'choose', 'show_hide', 'path', 'world_clock', 'timeline', 'workspace'] },
            name: { type: 'string', description: 'Its name. A state with a card shows the card\'s name without one. Send and receive are joined by having the same name.' },
            card: { type: 'string', description: 'state, event, show_hide: the id of the card it stands for (a deck by its front card).' },
            note: { type: 'string' },
            start: { type: 'boolean', description: 'state: lit before anything has happened (one per machine).' },
            value: { description: 'value: what it starts at, a number or true / false.' },
            n: { type: 'number', description: 'wait: points later. timer: seconds. counter: how many is full. dice: sides. signal: seconds a round. calculate: its second number when nothing is wired there.' },
            op: { type: 'string', enum: ['plus', 'minus', 'times', 'divided_by', 'smallest', 'largest', 'average', 'greater_than', 'less_than', 'at_least', 'at_most', 'equal_to', 'not_equal_to'], description: 'calculate: what it works out.' },
            shape: { type: 'string', enum: ['pulse', 'sine', 'square', 'saw', 'triangle', 'noise'], description: 'signal: its shape.' },
            options: { type: 'array', items: { type: 'string' }, description: 'choose, selector: the names of its options (ports opt:a, opt:b… / to:a, pos:a…).' },
            do: { type: 'string', enum: ['hide', 'show'], description: 'show_hide: what it does to its card while true.' },
            low: { type: 'number' }, high: { type: 'number' },
            wrap: { type: 'boolean', description: 'counter: start over when full.' },
            line: { type: 'string', description: 'timeline: a storyline\'s id.' },
            curve: { type: 'string', description: 'path: a curve\'s id.' },
            space: { type: 'string', description: 'workspace: another States workspace\'s id.' },
            x: { type: 'number' }, y: { type: 'number' },
          },
        } },
        wires: { type: 'array', maxItems: 120, items: {
          type: 'object', required: ['from'],
          properties: {
            ref: { type: 'string', description: 'Your own short name for this wire, so a later wire can go onto it (toWire).' },
            from: { type: 'string', description: 'A node: a ref of this request, or an id.' },
            fromPort: { type: 'string', description: 'Its output port. Default "out".' },
            to: { type: 'string', description: 'A node: a ref or an id.' },
            toPort: { type: 'string', description: 'Its input port. Default "in"; an event\'s condition is "if".' },
            toWire: { type: 'string', description: 'Instead of to: a change wire (ref or id). What arrives makes that change happen.' },
            compare: { type: 'string', enum: ['<', '<=', '=', '!=', '>=', '>'], description: 'Out of a value: true when the value compares this way with number.' },
            number: { type: 'number' },
            not: { type: 'boolean', description: 'True when its source is NOT.' },
            plain: { type: 'boolean', description: 'state to state: a plain line (a relationship), not a change.' },
            does: { type: 'string', enum: ['add', 'set'], description: 'Into a value: what it does to it.' },
            by: { type: 'number', description: 'How much it adds, or what it sets it to.' },
            name: { type: 'string' },
          },
        } },
      },
    },
  },
  {
    name: 'edit_states',
    description: 'Change, move or take out nodes and wires of a States workspace. nodes and wires take the same fields as build_states plus id; only what you give changes. remove takes node and wire ids (a node\'s wires go with it). Only when the artist asked.',
    inputSchema: {
      type: 'object', required: ['toolId'],
      properties: {
        toolId: { type: 'string' },
        nodes: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: true } },
        wires: { type: 'array', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } }, additionalProperties: true } },
        remove: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'run_states',
    description: 'Work a States workspace by hand, as a click on it does: light or unlight a state, fire an event (or a wait, pick one, signal), set a value, poke a gadget\'s input port (flip a switch, add to a counter, start a timer, roll a dice), or answer a choose that is asking (option: its id or name). Returns what is lit and true, every number, and each choose still asking. read_states marks a choose waiting for an answer with asking: true. One undo takes it back.',
    inputSchema: {
      type: 'object', required: ['toolId', 'id', 'do'],
      properties: {
        toolId: { type: 'string' }, id: { type: 'string', description: 'The node\'s id.' },
        do: { type: 'string', enum: ['light', 'unlight', 'fire', 'set', 'poke', 'answer'] },
        option: { type: 'string', description: 'answer: the option id (e.g. "a") or its name (e.g. "Yes").' },
        value: { description: 'set: a number, or true / false.' },
        port: { type: 'string', description: 'poke: the input port. Default "in".' },
      },
    },
  },
  {
    name: 'read_storyline',
    description: 'Read a storyline (dots joined by straight lines: a story and its branches, a family tree, any tree): each dot with its title, where it is on the canvas, the dots it is joined to and the cards on it; the storyline\'s title and description; where its time marker is. list_tools gives the storylines. Read-only.',
    inputSchema: { type: 'object', required: ['toolId'], properties: { toolId: { type: 'string', description: 'The storyline\'s id, from list_tools.' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'build_storyline',
    description: 'Draw a new storyline, or add dots to one that is there (toolId), all in one undo. A storyline has a base: a straight line of dots, left to right. A dot without "from" is the next dot along the base; a dot with "from" grows from that dot as a branch (and a dot from a branch dot carries the branch on). Give each dot a ref and use refs (or dot ids) in "from". Leave x and y out and dots are spaced to leave room for cards. Cards named on a dot are linked to it: they stay where they are and go with the dot when it is dragged.',
    inputSchema: {
      type: 'object', required: ['dots'],
      properties: {
        toolId: { type: 'string', description: 'Add to this storyline. Leave out to draw a new one in an empty spot.' },
        at: { type: 'object', description: 'A new storyline\'s start, in canvas units. Leave out for an empty spot in view.', properties: { x: { type: 'number' }, y: { type: 'number' } } },
        title: { type: 'string', description: 'Its label under the base line.' },
        description: { type: 'string' },
        dots: { type: 'array', maxItems: 80, items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Your own short name for it, used in "from" of this request.' },
            title: { type: 'string' },
            from: { type: 'string', description: 'The dot it branches from (a ref or a dot id). Leave out for the next dot on the base.' },
            cards: { type: 'array', items: { type: 'string' }, description: 'Ids of cards to link to this dot.' },
            x: { type: 'number' }, y: { type: 'number' },
          },
        } },
      },
    },
  },
  {
    name: 'edit_storyline',
    description: 'Change a storyline, one undo: its title, description, colour, whether it stands up in the tilted view; its dots (title, place, the cards on it); join or unjoin two dots; take dots out (the lines close up) or a whole branch from a dot onward; put its time marker at a dot. A base dot stays on the base line (only its x moves). Gives the storyline back as read_storyline does.',
    inputSchema: {
      type: 'object', required: ['toolId'],
      properties: {
        toolId: { type: 'string' },
        title: { type: 'string' }, description: { type: 'string' },
        color: { type: 'string', description: 'A CSS colour; empty for the default.' },
        standUp: { type: 'boolean' }, snap: { type: 'boolean' },
        dots: { type: 'array', maxItems: 80, items: {
          type: 'object', required: ['id'],
          properties: {
            id: { type: 'string' }, title: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' },
            cards: { type: 'array', items: { type: 'string' }, description: 'The cards on this dot, replacing what was there ([] for none).' },
          },
        } },
        join: { type: 'array', items: { type: 'object', required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' } } } },
        unjoin: { type: 'array', items: { type: 'object', required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'string' } } } },
        remove: { type: 'array', items: { type: 'string' }, description: 'Dot ids to take out.' },
        removeBranchFrom: { type: 'array', items: { type: 'string' }, description: 'Dot ids: each goes with everything that hangs off it.' },
        markerAt: { type: 'string', description: 'A base dot\'s id: the time marker goes there and the changes up to it are made. "start": before anything has happened.' },
      },
    },
  },
  {
    name: 'read_scene',
    description: 'Read a scene card\'s face in full: its splits (parts side by side or stacked, with their shares) and its sections, each with its id, name, text, colour, the card or deck put on it and the cards linked to it. read_cards shows a short outline; this gives the ids edit_scene needs. Read-only.',
    inputSchema: { type: 'object', required: ['cardId'], properties: { cardId: { type: 'string', description: 'The scene card\'s id.' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'edit_scene',
    description: 'Lay out a scene card\'s face, one undo. A face is sections (named, coloured rectangles) held in splits. Either give "layout", the whole face as an outline that replaces what is there, and / or "steps" done in order on the face. A card PUT on a section copies its header, text and picture onto the section (a closed deck goes in whole, as that section\'s cast; put on a heading, the cards are handed down to the sections under it). A card LINKED to a section only points at it; nothing in the section changes. To make a scene card first: deal_deck with type scene, or edit_cards type scene. If any step fails, nothing is changed.',
    inputSchema: {
      type: 'object', required: ['cardId'],
      properties: {
        cardId: { type: 'string' },
        layout: { type: 'object', description: 'The whole face. A split: { split: "side_by_side" | "stacked", sizes: [shares], parts: [ ... ], folded }. A section: { name, notes, color, cards: [ids put on it], links: [ids linked to it], bump, tab, ref }. A stacked split whose first part is a section is a headed section (an act with its scenes under it).' },
        steps: { type: 'array', maxItems: 80, items: {
          type: 'object', required: ['do'],
          properties: {
            do: { type: 'string', enum: ['split', 'strip', 'set', 'put', 'link', 'unlink', 'refresh', 'clear', 'remove', 'move'], description: 'split: divide a section in two, the new half after it (way, name, color, notes, ref). strip: a new section along an edge of the whole face (side, share, name, ref). set: a section\'s name, notes, color, bump, tab, label, live; or a split\'s sizes, folded. put / link / unlink: cards on a section. refresh: take the card\'s content as it is now. clear: empty a section. remove: take a section or split away. move: a section beside another (to, where).' },
            section: { type: 'string', description: 'A section\'s (or split\'s) id from read_scene, or a ref from an earlier step.' },
            ref: { type: 'string', description: 'split, strip: your own name for the new section, for later steps.' },
            way: { type: 'string', enum: ['side_by_side', 'stacked'] },
            side: { type: 'string', enum: ['top', 'bottom', 'left', 'right'] },
            share: { type: 'number', description: 'strip: its part of the face, 0 to 1.' },
            name: { type: 'string' }, notes: { type: 'string' }, color: { type: 'string' },
            bump: { type: 'boolean', description: 'Stands taller than its slot.' },
            tab: { type: 'boolean', description: 'A small name tab on its top-right edge.' },
            label: { type: 'boolean', description: 'Its name in the middle.' },
            live: { type: 'boolean', description: 'Follows its card as the card is now.' },
            folded: { type: 'boolean' },
            sizes: { type: 'array', items: { type: 'number' } },
            cards: { type: 'array', items: { type: 'string' } },
            to: { type: 'string' }, where: { type: 'string', enum: ['left', 'right', 'top', 'bottom', 'swap'] },
          },
        } },
      },
    },
  },
  {
    name: 'read_3d_set',
    description: 'Read a 3D set: its ground, everything that stands in it (models, shapes, cameras) with where it stands, its size and which way it faces, each camera\'s lens, and its paths with their points and what rides them. Read-only.',
    inputSchema: { type: 'object', required: ['setId'], properties: { setId: { type: 'string', description: 'The 3D set\'s id, from make_3d_set or list_tools.' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_to_3d_set',
    description: 'Add shapes (cube, sphere, cylinder, cone, plane) or cameras to a 3D set. Each is a new card docked under the set, standing in the set where you say. A camera looks out of its front: aim it with lookAt. One undo takes them back. To bring the artist\'s own models in, use make_3d_set.',
    inputSchema: {
      type: 'object', required: ['setId', 'things'],
      properties: {
        setId: { type: 'string' },
        things: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'object', required: ['shape'], properties: {
          shape: { type: 'string', enum: ['cube', 'sphere', 'cylinder', 'cone', 'plane', 'camera'] },
          name: { type: 'string' },
          x: { type: 'number', description: 'Across the ground, 0 to 1.' }, y: { type: 'number', description: 'Deep into the ground, 0 (back) to 1 (front).' },
          height: { type: 'number', description: 'Lifted off the ground, a part of the set\'s width.' },
          size: { type: 'number' }, turn: { type: 'number' }, tip: { type: 'number' },
          lookAt: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, height: { type: 'number' } } },
          mm: { type: 'number', description: 'camera: its lens, millimetres.' }, focus: { type: 'number' },
        } } },
      },
    },
  },
  {
    name: 'draw_path',
    description: 'Draw a path: a smooth line through the points you give. With setId it belongs to that 3D set (x and y 0 to 1 of its ground, height a part of its width) and is a real path in 3D; without, it lies on the canvas (canvas units). Cards under the set named in riders (models, cameras) ride it: they set off at "starts" and take "seconds" to reach the end, then loop, stop or come back. play_paths runs the clock. One undo takes it back.',
    inputSchema: {
      type: 'object', required: ['points'],
      properties: {
        setId: { type: 'string' }, name: { type: 'string' },
        points: { type: 'array', minItems: 2, maxItems: 200, items: { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' }, height: { type: 'number' }, label: { type: 'string', description: 'A few words shown by the point.' }, slow: { type: 'boolean', description: 'What rides slows into this point and gathers speed out of it.' }, corner: { type: 'boolean', description: 'The line turns sharply here.' }, twist: { type: 'number', description: 'The path rolled about its own line here, degrees.' } } } },
        closed: { type: 'boolean', description: 'The end joins the start.' },
        smooth: { type: 'boolean', description: 'Default true. false: straight lines between the points.' },
        color: { type: 'string' }, width: { type: 'number', description: 'Canvas units.' }, arrow: { type: 'boolean', description: 'An arrow head on its end.' },
        riders: { type: 'array', items: { type: 'string' }, description: 'Ids of cards under the set whose models ride the path.' },
        starts: { type: 'number', description: 'Seconds on the set\'s clock when the riders set off.' },
        seconds: { type: 'number', description: 'How long the ride takes.' },
        after: { type: 'string', enum: ['loop', 'stop', 'pingpong'] }, ease: { type: 'boolean' },
      },
    },
  },
  {
    name: 'edit_path',
    description: 'Change a path, one undo: its name, look, its points (the whole list, replacing what was there), what rides it and how, and its timing; or remove it. Only what you give changes.',
    inputSchema: {
      type: 'object', required: ['pathId'],
      properties: {
        pathId: { type: 'string', description: 'From read_3d_set or draw_path.' },
        name: { type: 'string' },
        points: { type: 'array', minItems: 2, maxItems: 200, items: { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' }, height: { type: 'number' }, label: { type: 'string', description: 'A few words shown by the point.' }, slow: { type: 'boolean', description: 'What rides slows into this point and gathers speed out of it.' }, corner: { type: 'boolean', description: 'The line turns sharply here.' }, twist: { type: 'number', description: 'The path rolled about its own line here, degrees.' } } } },
        closed: { type: 'boolean' }, smooth: { type: 'boolean' }, color: { type: 'string' }, width: { type: 'number' }, arrow: { type: 'boolean' },
        riders: { type: 'array', description: 'Everything that rides it, replacing the list ([] takes all off).', items: { type: 'object', required: ['id'], properties: {
          id: { type: 'string' },
          lead: { type: 'number', description: 'How far along it starts, 0 to 1: several on one path follow each other.' },
          aim: { type: 'boolean', description: 'Faces the way the path runs (default on).' },
          heading: { type: 'number', description: 'Turned from the way the path runs, degrees.' },
          bank: { type: 'number', description: 'Leans into turns, percent.' },
          lift: { type: 'number', description: 'Carried above the path, a part of the set\'s width.' },
          side: { type: 'number', description: 'Carried to its side, a part of the set\'s width.' },
        } } },
        starts: { type: 'number' }, seconds: { type: 'number' }, after: { type: 'string', enum: ['loop', 'stop', 'pingpong'] }, ease: { type: 'boolean' },
        remove: { type: 'boolean', description: 'Take the path away.' },
      },
    },
  },
  {
    name: 'play_paths',
    description: 'Run a 3D set\'s clock: what rides its paths moves. play, pause, and / or go to a time in seconds. Seen in the tilted view. Not an undo step.',
    inputSchema: { type: 'object', properties: { setId: { type: 'string', description: 'Leave out for paths that belong to no set.' }, do: { type: 'string', enum: ['play', 'pause'] }, seconds: { type: 'number' } } },
  },
  {
    name: 'list_effects',
    description: 'The effects VidBars has (bloom, ink, halftone, grade, film looks and more), each with what it does and its settings. With kind: that one effect in full, each setting\'s range, default and meaning. Read-only.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read_effects',
    description: 'The effect cards lined up to the right of a picture card, in the order they run, with their settings. Read-only.',
    inputSchema: { type: 'object', required: ['cardId'], properties: { cardId: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_effects',
    description: 'Put effects on a picture card: each is a new effect card lined up to the right of the card, after the ones there. They run left to right on the card\'s face picture and the face shows the result; the picture itself is not changed. One undo takes them back. delete_cards removes an effect card.',
    inputSchema: { type: 'object', required: ['cardId', 'effects'], properties: { cardId: { type: 'string' }, effects: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { id: { type: 'string', description: 'edit_effects: the effect card\'s id (read_effects).' }, kind: { type: 'string', description: 'add_effects: the effect, from list_effects.' }, params: { type: 'object', description: 'Settings by key, numbers within each one\'s range. Those left out keep their value.' }, text: { type: 'string', description: 'For effects that take words (a Segment card names what to pick out).' }, off: { type: 'boolean', description: 'Switched off: skipped.' }, solo: { type: 'boolean', description: 'The only effect its row runs.' } } } } } },
  },
  {
    name: 'edit_effects',
    description: 'Change effect cards: their settings, text, switched off, solo. Only what you give changes. One undo.',
    inputSchema: { type: 'object', required: ['effects'], properties: { effects: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', properties: { id: { type: 'string', description: 'edit_effects: the effect card\'s id (read_effects).' }, kind: { type: 'string', description: 'add_effects: the effect, from list_effects.' }, params: { type: 'object', description: 'Settings by key, numbers within each one\'s range. Those left out keep their value.' }, text: { type: 'string', description: 'For effects that take words (a Segment card names what to pick out).' }, off: { type: 'boolean', description: 'Switched off: skipped.' }, solo: { type: 'boolean', description: 'The only effect its row runs.' } } } } } },
  },
  {
    name: 'save_effects',
    description: 'Save a card\'s picture as its effects make it, at full size, as a file. Gives the file\'s path; deal_deck (media file, from the card) brings it in as a card of its own.',
    inputSchema: { type: 'object', required: ['cardId'], properties: { cardId: { type: 'string' } } },
  },
  {
    name: 'read_rough_cut',
    description: 'Read a Rough Cut: its clips in order with where each starts on the timeline, how long it runs, its row, the part of a movie in the cut, and which are picked. Read-only.',
    inputSchema: { type: 'object', required: ['toolId'], properties: { toolId: { type: 'string', description: 'The Rough Cut\'s id, from list_tools.' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'edit_rough_cut',
    description: 'Cut in a Rough Cut, one undo. Done in this order: split clips at a time; change clips (trim in / out, how long a picture shows, where it starts, its row, picked, name); take clips out; lay clips end to end on the top row in an order; set the frame every shot is shown in. add_to_rough_cut brings cards in.',
    inputSchema: {
      type: 'object', required: ['toolId'],
      properties: {
        toolId: { type: 'string' },
        split: { type: 'array', items: { type: 'object', required: ['id', 'at'], properties: { id: { type: 'string' }, at: { type: 'number', description: 'Seconds on the timeline, inside the clip.' } } } },
        clips: { type: 'array', items: { type: 'object', required: ['id'], properties: {
          id: { type: 'string' }, name: { type: 'string' },
          in: { type: 'number', description: 'A movie: where the part in the cut begins, seconds into the movie.' },
          out: { type: 'number', description: 'A movie: where it ends.' },
          seconds: { type: 'number', description: 'How long it runs (a picture: how long it shows).' },
          start: { type: 'number', description: 'Where it starts on the timeline, seconds.' },
          row: { type: 'number', description: '0 is the top row.' },
          pick: { type: 'boolean', description: 'Picked: goes out with deck_of_picks.' },
        } } },
        remove: { type: 'array', items: { type: 'string' } },
        order: { type: 'array', items: { type: 'string' }, description: 'Clip ids: laid end to end on the top row in this order.' },
        frame: { description: 'One frame for every shot: { aspect (width / height), fill }. null: each shot keeps its own shape.' },
      },
    },
  },
  {
    name: 'deck_of_picks',
    description: 'Deal a Rough Cut\'s picked clips out as a deck of cards docked under it, each with its trim. One undo.',
    inputSchema: { type: 'object', required: ['toolId'], properties: { toolId: { type: 'string' } } },
  },
  {
    name: 'read_viewer',
    description: 'What a Viewer is showing, and where it is. Read-only.',
    inputSchema: { type: 'object', required: ['viewerId'], properties: { viewerId: { type: 'string', description: 'From list_tools (type viewer).' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'show_in_viewer',
    description: 'Show a card in a Viewer: the Viewer (a new one, or viewerId) is set against the card\'s side and shows what the card holds, big: its picture, movie, 3D model or text. A deck named by its front card gives the Viewer every card in it to step through. The card is not moved. One undo.',
    inputSchema: {
      type: 'object', required: ['cardId'],
      properties: {
        cardId: { type: 'string' }, viewerId: { type: 'string', description: 'Leave out for a new Viewer.' },
        side: { type: 'string', enum: ['right', 'left', 'top', 'bottom'], description: 'Which side of the card. Default right.' },
        item: { type: 'number', description: 'Which thing the card holds to show, counted from 0 (the result lists them). Default: its face.' },
      },
    },
  },
  {
    name: 'read_view',
    description: 'Where the artist is looking: the zoom (percent), the part of the canvas in view (canvas units), and how far the view is tilted into 3D. Read-only.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'move_view',
    description: 'Move the artist\'s view: onto cards, a tool or a spot (in the middle of the screen), with fit to zoom so they fill it; set the zoom; tilt into 3D (0 is flat) and spin. Use it to show the artist what you made, e.g. a 3D set tilted. Nothing on the canvas changes. Only move the view when it helps the artist see; do not move it while they are working elsewhere unless asked.',
    inputSchema: {
      type: 'object',
      properties: {
        cards: { type: 'array', items: { type: 'string' } }, toolId: { type: 'string' },
        at: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
        fit: { type: 'boolean', description: 'Zoom so the cards or tool named fill the view.' },
        zoom: { type: 'number', description: 'Percent, 1 to 400.' },
        tilt: { type: 'number', description: 'Degrees into 3D, 0 (flat) to 89.' },
        spin: { type: 'number', description: 'Degrees about the upright, tilted.' },
      },
    },
  },
  {
    name: 'read_loop_strip',
    description: 'Read a loop strip: its row left to right (columns of picture cards, each with its mode, and effects with their settings and any Depth or Segment inputs tucked under them), its look rows, the results at its right end, how many results a run would make, and how a run is going. Read-only.',
    inputSchema: { type: 'object', properties: { toolId: { type: 'string' } }, required: ['toolId'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'edit_loop_strip',
    description: 'Set up a loop strip, all in one undo. A strip runs its effects, in order, over every picture docked in its first column; a column after a blend effect (multiply, screen, overlay) holds what that effect mixes in, and a run makes one result per combination. Docking moves the cards themselves onto the strip; undock sets them down just under it. list_effects gives the effect kinds and their settings.',
    inputSchema: {
      type: 'object',
      properties: {
        toolId: { type: 'string' },
        columns: { type: 'array', description: 'Change columns.', items: { type: 'object', properties: { column: { type: 'string' }, name: { type: 'string' }, mode: { type: 'string', enum: ['each', 'pick'] } }, required: ['column'] } },
        addColumns: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, mode: { type: 'string', enum: ['each', 'pick'] }, at: { description: 'start, end (default), or a place in the row as a number, 0 first.' } } } },
        dock: { type: 'array', description: 'Picture cards into a column (the first when column is left out; "new:1" is the first of addColumns).', items: { type: 'object', properties: { column: { type: 'string' }, cards: { type: 'array', items: { type: 'string' } } }, required: ['cards'] } },
        undock: { type: 'array', items: { type: 'string' }, description: 'Card ids to take off the strip.' },
        addEffects: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, params: { type: 'object' }, text: { type: 'string' }, off: { type: 'boolean' }, at: { type: 'number', description: 'Place in its row, 0 first. Left out: the end.' }, row: { type: 'number', description: '0 the strip\'s own row (default), 1 the first look row.' }, under: { type: 'string', description: 'For a depth or segment effect: the id of the effect it feeds, tucked under it.' } }, required: ['kind'] } },
        effects: { type: 'array', description: 'Change effects already on the strip.', items: { type: 'object', properties: { id: { type: 'string' }, params: { type: 'object' }, text: { type: 'string' }, off: { type: 'boolean' } }, required: ['id'] } },
        move: { type: 'array', description: 'Move a column or an effect along its row (or to another row).', items: { type: 'object', properties: { id: { type: 'string' }, at: { type: 'number', description: 'Place in the row, 0 first.' }, row: { type: 'number' } }, required: ['id', 'at'] } },
        remove: { type: 'array', items: { type: 'string' }, description: 'Effect ids, or the ids of empty columns.' },
        addRow: { type: 'boolean', description: 'A new, empty look row under the strip.' },
        emptyResults: { type: 'boolean', description: 'Set the results down under the strip, leaving its end clear.' },
      },
      required: ['toolId'],
    },
  },
  {
    name: 'run_loop_strip',
    description: 'Run a loop strip (do: run, the default) or stop it (do: stop). Each result is a full-size picture saved as its own file and lands as a card at the strip\'s right end. A short run is finished when this answers; a long one goes on, and read_loop_strip says how far it is. Runs of more than 100 results are the artist\'s to start.',
    inputSchema: { type: 'object', properties: { toolId: { type: 'string' }, do: { type: 'string', enum: ['run', 'stop'] } }, required: ['toolId'] },
  },
  {
    name: 'read_prompts',
    description: 'Read a Card Prompts window (its prompt tabs, which one is in use, and the cards feeding it with the words on their backs) or a Prompt Pad (its text, word groups and saved prompts). Read-only.',
    inputSchema: { type: 'object', properties: { toolId: { type: 'string' } }, required: ['toolId'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'edit_prompts',
    description: 'Write in a Card Prompts window or a Prompt Pad, in one undo: text for the tab in use; for Card Prompts also other tabs by number (1 first) or name, new tabs, removing tabs, and which tab is in use. The words on the cards are the cards\' own: change those with edit_cards (details). Write a prompt only when the artist asks for one.',
    inputSchema: {
      type: 'object',
      properties: {
        toolId: { type: 'string' },
        text: { type: 'string', description: 'What the tab in use holds.' },
        tabs: { type: 'array', items: { type: 'object', properties: { tab: { description: 'Its number (1 first) or its name.' }, name: { type: 'string' }, text: { type: 'string' } }, required: ['tab'] } },
        addTabs: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, text: { type: 'string' } } } },
        removeTabs: { type: 'array', items: {}, description: 'Tab numbers or names.' },
        use: { description: 'The tab to bring to the front: its number or name.' },
        feed: { type: 'array', items: { type: 'string' }, description: 'Card Prompts: card ids to set against the window\'s left side, so their backs become its words. This moves those cards.' },
      },
      required: ['toolId'],
    },
  },
  {
    name: 'read_cabinet',
    description: 'Read a cabinet: its drawers, which one is open, and what each holds (cards and decks put away off the canvas). Read-only.',
    inputSchema: { type: 'object', properties: { toolId: { type: 'string' } }, required: ['toolId'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'edit_cabinet',
    description: 'Work a cabinet, in one undo: name drawers, add drawers, put cards away in a drawer (they leave the canvas, a closed deck going in as one thing), take things out again (where asked, or in a row just under the cabinet), move a thing to another drawer, open a drawer or close them. Put cards away only when the artist asks.',
    inputSchema: {
      type: 'object',
      properties: {
        toolId: { type: 'string' },
        drawers: { type: 'array', items: { type: 'object', properties: { drawer: { type: 'string' }, name: { type: 'string' } }, required: ['drawer', 'name'] } },
        addDrawers: { type: 'number' },
        putAway: { type: 'array', items: { type: 'object', properties: { drawer: { type: 'string' }, cards: { type: 'array', items: { type: 'string' } } }, required: ['drawer', 'cards'] } },
        takeOut: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, at: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } } }, required: ['item'] } },
        move: { type: 'array', items: { type: 'object', properties: { item: { type: 'string' }, to: { type: 'string', description: 'A drawer id.' } }, required: ['item', 'to'] } },
        open: { description: 'A drawer id to open, or null to close the open one.' },
      },
      required: ['toolId'],
    },
  },
  {
    name: 'read_media_pool',
    description: 'Read a Media Pool: the folder on this computer it shows, its subfolders and its files (pictures, movies, sounds, 3D models) with their full paths. With folder, the pool is pointed at that folder first (one undo). To bring a file in as a card, deal_deck with media { file }.',
    inputSchema: { type: 'object', properties: { toolId: { type: 'string' }, folder: { type: 'string', description: 'A folder to point the pool at: a full path, or one from folders / parent.' }, kind: { type: 'string', enum: ['image', 'video', 'audio', 'model'], description: 'Only files of this kind.' } }, required: ['toolId'] },
  },
  {
    name: 'edit_blocks',
    description: 'Change what a card holds: its blocks (read_cards gives them with their ids, in reading order). In one undo: name a block, write its text, swap its media; remove blocks; add blocks; put them in order; move a block to another card; take a block out as a card of its own; merge other cards into this one as blocks (those cards are then gone). A card keeps at least one block. Only when the artist asked for the change.',
    inputSchema: {
      type: 'object', required: ['cardId'],
      properties: {
        cardId: { type: 'string' },
        blocks: { type: 'array', description: 'Blocks to change.', items: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, name: { type: 'string' }, text: { type: 'string' }, media: MEDIA_ENTRY } } },
        remove: { type: 'array', items: { type: 'string' }, description: 'Block ids to delete.' },
        add: { type: 'array', description: 'New blocks, each holding one media.', items: { type: 'object', required: ['media'], properties: { name: { type: 'string' }, text: { type: 'string' }, media: MEDIA_ENTRY } } },
        order: { type: 'array', items: { type: 'string' }, description: 'Block ids in the order wanted; any left out follow as they were.' },
        moveTo: { type: 'array', items: { type: 'object', required: ['id', 'card'], properties: { id: { type: 'string' }, card: { type: 'string', description: 'The id of the card that takes the block.' } } } },
        takeOut: { type: 'array', items: { type: 'string' }, description: 'Block ids to make cards of their own.' },
        merge: { type: 'array', items: { type: 'string' }, description: 'Ids of other cards to merge into this one as blocks.' },
      },
    },
  },
]

for (const t of TOOLS) if (t.name !== 'send_file') t.inputSchema.properties.doing = DOING

const OPS = {
  list_cards: 'list', read_cards: 'read', list_decks: 'decks',
  edit_cards: 'edit', arrange_cards: 'arrange', set_deck: 'deck', link_cards: 'link', delete_cards: 'delete', select_cards: 'select', undo: 'undo',
  list_tools: 'tools', place_tool: 'place', make_3d_set: 'set3d', stand_in_3d_set: 'stand3d', make_gif: 'gif', make_movie: 'movie', add_to_rough_cut: 'cut',
  read_states: 'states', build_states: 'statesBuild', edit_states: 'statesEdit', run_states: 'statesRun',
  read_storyline: 'story', build_storyline: 'storyBuild', edit_storyline: 'storyEdit',
  read_scene: 'scene', edit_scene: 'sceneEdit',
  list_effects: 'fxList', read_effects: 'fxRead', add_effects: 'fxAdd', edit_effects: 'fxEdit', save_effects: 'fxSave',
  read_rough_cut: 'cutRead', edit_rough_cut: 'cutEdit', deck_of_picks: 'cutPicks',
  read_view: 'viewRead', move_view: 'viewMove',
  read_cabinet: 'cabinetRead', edit_cabinet: 'cabinetEdit',
  read_media_pool: 'poolRead',
  read_prompts: 'promptsRead', edit_prompts: 'promptsEdit',
  read_loop_strip: 'stripRead', edit_loop_strip: 'stripEdit', run_loop_strip: 'stripRun',
  read_viewer: 'viewerRead', show_in_viewer: 'viewerShow',
  read_3d_set: 'set3dRead', add_to_3d_set: 'set3dAdd', draw_path: 'pathDraw', edit_path: 'pathEdit', play_paths: 'pathPlay',
}

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

/** One media entry brought in, a model with its own picture (its thumbnail from the tool that made it). */
async function bringInWhole(m) {
  const got = await bringIn(m)
  if (got.type === 'model' && m.thumbnail && typeof m.thumbnail === 'object') {
    const pic = await bringIn(m.thumbnail)
    if (pic.type !== 'image') throw new Error('A thumbnail is a picture.')
    got.thumb = pic.url
  }
  return got
}

async function editCards(args) {
  const cards = []
  for (const c of Array.isArray(args.cards) ? args.cards : []) {
    cards.push(c.picture && typeof c.picture === 'object' ? { ...c, picture: await bringIn(c.picture) } : c)
  }
  return [{ type: 'text', text: JSON.stringify(await ask('edit', { ...args, cards }), null, 1) }]
}

async function editBlocks(args) {
  const blocks = [], add = []
  for (const b of Array.isArray(args.blocks) ? args.blocks : []) blocks.push(b.media && typeof b.media === 'object' ? { ...b, media: await bringInWhole(b.media) } : b)
  for (const b of Array.isArray(args.add) ? args.add : []) add.push(b.media && typeof b.media === 'object' ? { ...b, media: await bringInWhole(b.media) } : b)
  return [{ type: 'text', text: JSON.stringify(await ask('blocksEdit', { ...args, blocks, add }), null, 1) }]
}

async function dealDeck(args) {
  const cards = []
  for (const c of Array.isArray(args.cards) ? args.cards : []) {
    const media = []
    for (const m of Array.isArray(c.media) ? c.media : []) media.push(await bringInWhole(m))
    cards.push({ ...c, media })
  }
  const result = await ask('deal', { ...args, cards })
  return [{ type: 'text', text: JSON.stringify(result, null, 1) }]
}

const LOCAL = { get_card_media: getCardMedia, send_file: sendFile, deal_deck: dealDeck, edit_cards: editCards, edit_blocks: editBlocks }

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
        serverInfo: { name: 'vidbars', version: '1.16.0' },
        instructions: 'VidBars is the artist\'s card canvas. You may read cards and decks, hand out the media on cards as files, and deal a deck of cards: new cards, results brought in from another tool, and linked cards of cards that are there. You can use the tools of VidBars: set one down (place_tool), build a 3D set from cards that hold models (make_3d_set, stand_in_3d_set), add shapes and cameras to it and draw paths for them to ride (read_3d_set, add_to_3d_set, draw_path, edit_path, play_paths), put effects on picture cards (list_effects, add_effects, edit_effects, save_effects), run pictures through a loop strip (read_loop_strip, edit_loop_strip, run_loop_strip), read and write prompts in a Card Prompts window (read_prompts, edit_prompts), keep cards in a cabinet\'s drawers (read_cabinet, edit_cabinet), look through a folder in a Media Pool (read_media_pool), show a card big in a Viewer (show_in_viewer), move the artist\'s view to show them something (read_view, move_view), make a GIF or a movie of cards, add cards to a Rough Cut and cut there (read_rough_cut, edit_rough_cut, deck_of_picks), draw storylines and trees (build_storyline, edit_storyline), lay out the face of a scene card (read_scene, edit_scene), and set up state machines in a States workspace (read_states, build_states, edit_states, run_states). You may also change what is there when the artist asks for it: edit cards and their faces (edit_cards), the blocks a card holds (edit_blocks: add, remove, order, move, take out, merge), arrange, open and close decks, link, delete; each change is one undo, and undo takes your last one back. Do not change or delete anything the artist did not ask you to. Read before you deal or change, keep card text short, and tell the artist plainly what you did. The artist sees your pointer in VidBars with a bubble: give each request a few plain words in "doing". To use a card\'s picture or model with another tool, get_card_media then send_file to the upload address that tool gives; bring what comes back onto a card with deal_deck (media, and from: the cards it was made from). A 3D model that comes back with a preview picture is ONE media entry: the model, with the picture as its thumbnail.',
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
