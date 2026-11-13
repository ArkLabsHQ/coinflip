import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = resolve(process.env.REGTEST_SOURCE || join(root, '.research', 'regtest'))
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
if (revision !== 'a1b4fdc859b41281d00d16596408055f254225bf') throw new Error('Unexpected regtest source revision')
const { loadEnv } = await import(pathToFileURL(join(source, 'lib', 'env.mjs')).href)
loadEnv(source, process.env.REGTEST_ENV || join(root, '.env.regtest'))
const project = process.env.REGTEST_PROJECT || 'arkade-regtest'
const container = `${process.env.REGTEST_CONTAINER_PREFIX || ''}intent-solver`
const inspect = JSON.parse(execFileSync('docker', ['inspect', container], { encoding: 'utf8' }))[0]
if (inspect.Config.Labels?.['com.docker.compose.project'] !== project ||
    inspect.Config.Labels?.['com.docker.compose.service'] !== 'intent-solver' ||
    !inspect.Mounts.some(mount => mount.Destination === '/data' && mount.Type === 'volume' && mount.Name.startsWith(project + '_'))) {
  throw new Error('Refusing to replace a solver outside the selected test project')
}
const info = await fetch(`http://127.0.0.1:${process.env.ARKD_PORT}/v1/info`, { signal: AbortSignal.timeout(10_000) })
if (!info.ok || (await info.json()).network !== 'regtest') throw new Error('Relay setup requires a regtest operator')

const temporary = mkdtempSync(join(tmpdir(), 'coinflip-relay-'))
const overlay = join(temporary, 'relay.json')
try {
  writeFileSync(overlay, JSON.stringify({ services: { 'intent-solver': {
    command: ['relay'],
    environment: { ADMIN_HOST: '0.0.0.0', ADMIN_PORT: '8787', RELAY_PROTOCOL: 'nostr' },
    healthcheck: { test: ['CMD', 'node', '-e', "fetch('http://127.0.0.1:8787/api/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"] },
  } } }))
  const compose = ['compose', '-p', project,
    '-f', join(source, 'docker', 'compose.base.yml'),
    '-f', join(source, 'docker', 'compose.ark.yml'),
    '-f', join(source, 'docker', 'compose.evm.yml'),
    '-f', overlay,
    ...['base', 'ark', 'emulator', 'lightning', 'nostr', 'intent-solver'].flatMap(profile => ['--profile', profile])]
  const resolved = JSON.parse(execFileSync('docker', [...compose, 'config', '--format', 'json'], { encoding: 'utf8', env: process.env }))
  if (resolved.name !== project || resolved.services['intent-solver'].container_name !== container) {
    throw new Error('Resolved compose project does not match the selected test solver')
  }
  execFileSync('docker', [...compose, 'up', '-d', '--no-deps', '--force-recreate', 'intent-solver'], { stdio: 'inherit', env: process.env })
} finally {
  unlinkSync(overlay)
  rmdirSync(temporary)
}

const deadline = Date.now() + 90_000
for (;;) {
  try {
    const response = await fetch(`http://127.0.0.1:${process.env.INTENT_SOLVER_PORT}/api/healthz`, { signal: AbortSignal.timeout(3000) })
    if (response.ok && (await response.json()).mode === 'relay') break
  } catch { /* Wait for the recreated service to bind its admin listener. */ }
  if (Date.now() >= deadline) throw new Error('Regtest solver did not enter relay mode')
  await new Promise(resolve => setTimeout(resolve, 1000))
}
console.log(`Regtest solver ${container} now serves authenticated Nostr RFQs`)
