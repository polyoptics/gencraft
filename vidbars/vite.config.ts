import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'fs'
import path from 'path'
import type { Plugin } from 'vite'
import Busboy from 'busboy'
import crypto from 'crypto'

/** Vite plugin: POST /api/upload — saves files to public/uploads/, returns URL */
function fileUploadApi(): Plugin {
  const uploadDir = path.resolve(__dirname, 'public/uploads')

  function ensureDir() {
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true })
  }

  function detectMediaType(mime: string): 'image' | 'video' | 'audio' {
    if (mime.startsWith('video/')) return 'video'
    if (mime.startsWith('audio/')) return 'audio'
    return 'image'
  }

  return {
    name: 'file-upload-api',
    configureServer(server) {
      server.middlewares.use('/api/upload', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'Method not allowed' }))
          return
        }

        ensureDir()
        const bb = Busboy({ headers: req.headers as Record<string, string> })
        let fileProcessed: Promise<{ url: string; type: string; originalName: string }> | null = null

        bb.on('file', (_fieldname: string, file: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
          const { filename, mimeType } = info
          const uuid = crypto.randomUUID().slice(0, 8)
          const safeName = (filename || 'upload').replace(/[^a-zA-Z0-9._-]/g, '_')
          const diskName = `${uuid}-${safeName}`
          const diskPath = path.join(uploadDir, diskName)
          const ws = fs.createWriteStream(diskPath)
          file.pipe(ws)

          fileProcessed = new Promise((resolve, reject) => {
            ws.on('finish', () => resolve({
              url: `/uploads/${diskName}`,
              type: detectMediaType(mimeType),
              originalName: filename,
            }))
            ws.on('error', reject)
          })
        })

        bb.on('finish', async () => {
          res.setHeader('Content-Type', 'application/json')
          if (fileProcessed) {
            try {
              const result = await fileProcessed
              res.end(JSON.stringify(result))
            } catch {
              res.statusCode = 500
              res.end(JSON.stringify({ error: 'Write failed' }))
            }
          } else {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'No file received' }))
          }
        })

        bb.on('error', () => {
          res.statusCode = 500
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: 'Upload failed' }))
        })

        req.pipe(bb)
      })
    },
  }
}

/** Tiny Vite plugin: serves GET/POST /api/user-templates backed by a JSON file */
function userTemplatesApi(): Plugin {
  const filePath = path.resolve(__dirname, 'user-templates.json')

  function readFile(): unknown[] {
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'))
      }
    } catch { /* ignore parse errors */ }
    return []
  }

  return {
    name: 'user-templates-api',
    configureServer(server) {
      server.middlewares.use('/api/user-templates', (req, res) => {
        res.setHeader('Content-Type', 'application/json')

        if (req.method === 'GET') {
          res.end(JSON.stringify(readFile()))
          return
        }

        if (req.method === 'POST') {
          let body = ''
          req.on('data', (chunk: Buffer) => { body += chunk.toString() })
          req.on('end', () => {
            try {
              const data = JSON.parse(body)
              fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
              res.end(JSON.stringify({ ok: true }))
            } catch (e) {
              res.statusCode = 400
              res.end(JSON.stringify({ error: 'Invalid JSON' }))
            }
          })
          return
        }

        res.statusCode = 405
        res.end(JSON.stringify({ error: 'Method not allowed' }))
      })
    },
  }
}

/** Vite plugin: GET/POST /api/snapshots — full scene snapshots stored as individual JSON files */
function snapshotsApi(): Plugin {
  const dir = path.resolve(__dirname, 'snapshots')

  function ensureDir() {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  }

  function listSnapshots(): { id: string; name: string; savedAt: number; file: string }[] {
    ensureDir()
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    return files.map(f => {
      try {
        const raw = fs.readFileSync(path.join(dir, f), 'utf-8')
        const data = JSON.parse(raw)
        return { id: data.id ?? f, name: data.name ?? f.replace('.json', ''), savedAt: data.savedAt ?? 0, file: f }
      } catch { return null }
    }).filter(Boolean) as { id: string; name: string; savedAt: number; file: string }[]
  }

  return {
    name: 'snapshots-api',
    configureServer(server) {
      // List all snapshots (metadata only)
      server.middlewares.use('/api/snapshots/list', (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(listSnapshots()))
      })

      // Get a specific snapshot by filename
      server.middlewares.use('/api/snapshots/load/', (req, res) => {
        const file = req.url?.replace(/^\//, '') ?? ''
        const filePath = path.join(dir, file)
        if (!file || !fs.existsSync(filePath)) {
          res.statusCode = 404
          res.end(JSON.stringify({ error: 'Not found' }))
          return
        }
        res.setHeader('Content-Type', 'application/json')
        fs.createReadStream(filePath).pipe(res)
      })

      // Save a new snapshot
      server.middlewares.use('/api/snapshots/save', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end('{}'); return }
        let body = ''
        req.on('data', (chunk: Buffer) => { body += chunk.toString() })
        req.on('end', () => {
          try {
            const data = JSON.parse(body)
            ensureDir()
            const safeName = (data.name || 'snapshot').replace(/[^a-zA-Z0-9_-]/g, '_')
            const fileName = `${safeName}.json`
            fs.writeFileSync(path.join(dir, fileName), JSON.stringify(data), 'utf-8')
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ ok: true, file: fileName }))
          } catch {
            res.statusCode = 400
            res.end(JSON.stringify({ error: 'Invalid JSON' }))
          }
        })
      })

      // Delete a snapshot
      server.middlewares.use('/api/snapshots/delete/', (req, res) => {
        if (req.method !== 'DELETE') { res.statusCode = 405; res.end('{}'); return }
        const file = req.url?.replace(/^\//, '') ?? ''
        const filePath = path.join(dir, file)
        if (file && fs.existsSync(filePath)) fs.unlinkSync(filePath)
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true }))
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), fileUploadApi(), userTemplatesApi(), snapshotsApi()],
})
