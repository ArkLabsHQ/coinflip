import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const compilerCommit = '5ff97f8f04a77163e21426db59259a80e3ae400a'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const compiler = process.env.ARKADEC_SOURCE ?? join(tmpdir(), `coinflip-compiler-${compilerCommit}`)
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, stdio: 'inherit' })
if (!existsSync(join(compiler, 'Cargo.toml'))) {
  if (process.env.ARKADEC_SOURCE) throw new Error('ARKADEC_SOURCE must name an existing compiler checkout')
  mkdirSync(compiler, { recursive: true })
  run('git', ['init'], compiler)
  run('git', ['remote', 'add', 'origin', 'https://github.com/arkade-os/compiler.git'], compiler)
  run('git', ['fetch', '--depth=1', 'origin', compilerCommit], compiler)
  run('git', ['checkout', '--detach', 'FETCH_HEAD'], compiler)
}
const actual = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: compiler, encoding: 'utf8' }).trim()
if (actual !== compilerCommit) throw new Error(`Expected compiler ${compilerCommit}, found ${actual}`)
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: compiler, encoding: 'utf8' }).trim()
if (dirty) throw new Error('Compiler checkout has local changes')
const check = process.argv.includes('--check')
const temporary = mkdtempSync(join(tmpdir(), 'coinflip-artifacts-'))
try {
  for (const name of ['coinflip', 'contest', 'bankroll_vault', 'fresh_pool_input', 'pool_game_vault']) {
    const output = join(temporary, `${name}.json`)
    run('cargo', ['run', '--locked', '--quiet', '--manifest-path', join(compiler, 'Cargo.toml'), '--', `contracts/${name}.ark`, '-o', output, '--deny', 'warnings'])
    const artifact = JSON.parse(readFileSync(output, 'utf8'))
    delete artifact.updatedAt
    for (const path of Object.keys(artifact.source.files)) artifact.source.files[path] = artifact.source.files[path].replaceAll('\r\n', '\n')
    const generated = `${JSON.stringify(artifact, null, 2)}\n`
    const target = join(root, 'packages/lib/src/artifact', `${name}.json`)
    if (check) {
      if (readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== generated) throw new Error(`${name} artifact differs; run npm run contracts:build`)
    } else {
      writeFileSync(target, generated)
    }
  }
} finally {
  if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith('coinflip-artifacts-')) {
    throw new Error('Unexpected artifact build directory')
  }
  rmSync(temporary, { recursive: true, force: true })
}
