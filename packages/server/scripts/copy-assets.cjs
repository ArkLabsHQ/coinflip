// Copy non-TS admin assets into dist after `tsc` (which only emits compiled JS).
// Without this, `npm start` / local dev would serve a stale dashboard.html — the
// Dockerfile copies it explicitly for the image build, but the build script
// itself must produce a complete dist so dev and prod stay in sync.
const fs = require('fs')
const path = require('path')

const srcDir = path.join(__dirname, '..', 'src', 'admin')
const destDir = path.join(__dirname, '..', 'dist', 'admin')

// Non-TS admin assets tsc doesn't emit. amount-validate.js is a dual-target
// (browser global + Node require) classifier shared with the unit test.
const assets = ['dashboard.html', 'amount-validate.js']

fs.mkdirSync(destDir, { recursive: true })
for (const f of assets) {
  fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f))
  console.log(`[build] copied admin/${f} -> dist/admin/`)
}
