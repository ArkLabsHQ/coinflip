# @arklabshq/contract-workflows-prototype

**Incubator** for the eventual `@arkade-os/contract-workflows`
framework. See
[`docs/superpowers/specs/2026-05-29-contract-workflows-framework.md`](../../docs/superpowers/specs/2026-05-29-contract-workflows-framework.md)
for the full architectural plan.

## Status

This package ships **option B** from the framework spec — a primitives
library for building state-machine contracts on Ark via arkade-script.
Contracts compose the primitives by hand; the DSL (option A) gets
extracted once 2-3 contracts have stabilized on this layer.

Today's surface:

```typescript
import { covenants, predicates, emulator } from '@arklabshq/contract-workflows-prototype'

// Covenants (enforced by the arkade-script emulator)
covenants.payTo(pkScript, amount)              // single-output covenant
covenants.atomicSweep(pkScript, pot, otherIn)  // cross-input + single-output
covenants.selfSend()                           // self-loop (banco delegate)

// Predicates (enforced by arkd inside the closure's condition script)
predicates.sha256(hash)                        // SHA256 preimage
predicates.hash160(hash)                       // HASH160 preimage

// Emulator handoff
emulator.computeTweakedKey(emulatorPk, script) // bind script→key
emulator.encodeWitness([...stack])             // EmulatorPacket witness blob
emulator.encodeIndex(n)                        // scriptnum index helper
emulator.addPacket(tx, entries)                // attach EmulatorPacket to a tx
```

These are the **proven** building blocks pulled out of:
- `arkade-coinflip` (this repo) — `atomicSweep`, the emulator
  utilities
- `arkade-os/banco` (referenced) — `selfSend` / delegate pattern
- The arkade-script-final HTLC test — `payTo`, `sha256` /
  `hash160` predicate shapes

## What this does NOT ship yet

- The `defineContract` DSL (option A from the spec)
- Richer predicates: `coinflipWinCondition`,
  `signedAttestation` (CHECKSIGFROMSTACK), `rangeCheck`
- Richer covenants: `splitRefund`, `nextStateBinding`
- A recovery state-machine driver
- The TS↔Rust port (mentioned in the framework spec as future)

## Why it lives here for now

Per the framework spec's adoption path: incubate inside `coinflip`
until the API is stable, then graduate to the upstream `arkade-os`
org. The coinflip refactor onto these primitives (already 90%
done via the `feat/r1-via-arkade-script` branch) is the first real
consumer; banco-style swap is the planned second.

## Building

```bash
cd packages/contract-workflows-prototype
npm install
npm run build
```

No standalone tests yet — the primitives are exercised through the
coinflip test suite (38 unit + structural tests on the parent
branch). Standalone property tests + a typed reference suite are the
next iteration.
