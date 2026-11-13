import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, sep } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const name = process.argv[2]
if (!['lib', 'server'].includes(name)) throw new Error('Expected lib or server')
const target = resolve(root, 'packages', name, 'dist')
const expected = resolve(root, 'packages', name) + sep
if (!target.startsWith(expected) || target === expected) throw new Error('Invalid build directory')
rmSync(target, { recursive: true, force: true })
