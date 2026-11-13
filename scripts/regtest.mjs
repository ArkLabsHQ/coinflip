import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = join(root, '.research', 'regtest')
const revision = 'a1b4fdc859b41281d00d16596408055f254225bf'
const git = args => execFileSync('git', args, { cwd: source, stdio: 'inherit' })
if (!existsSync(join(source, '.git'))) {
  mkdirSync(source, { recursive: true })
  git(['init'])
  git(['remote', 'add', 'origin', 'https://github.com/ArkLabsHQ/arkade-regtest.git'])
  git(['fetch', '--depth=1', 'origin', revision])
  git(['checkout', '--detach', 'FETCH_HEAD'])
}
const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
if (actual !== revision) throw new Error('Unexpected regtest revision: ' + actual)
const args = process.argv.slice(2)
if (!args.length) throw new Error('Pass a regtest command, such as start or stop')
if (!args.includes('--env')) args.push('--env', process.env.REGTEST_ENV || join(root, '.env.regtest'))
const result = spawnSync(process.execPath, [join(source, 'regtest.mjs'), ...args], { cwd: root, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
