import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'fs'
import path from 'path'
import type { Plugin } from 'vite'

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

export default defineConfig({
  plugins: [react(), tailwindcss(), userTemplatesApi()],
})
