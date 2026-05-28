// Copy non-TS admin assets into dist after `tsc` (which only emits compiled JS).
// Without this, `npm start` / local dev would serve a stale dashboard.html — the
// Dockerfile copies it explicitly for the image build, but the build script
// itself must produce a complete dist so dev and prod stay in sync.
const fs = require('fs')
const path = require('path')

const src = path.join(__dirname, '..', 'src', 'admin', 'dashboard.html')
const destDir = path.join(__dirname, '..', 'dist', 'admin')

fs.mkdirSync(destDir, { recursive: true })
fs.copyFileSync(src, path.join(destDir, 'dashboard.html'))
console.log('[build] copied admin/dashboard.html -> dist/admin/')
