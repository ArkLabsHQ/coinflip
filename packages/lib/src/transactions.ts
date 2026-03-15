/**
 * Transaction building for coinflip games using SDK primitives.
 */

import { createHash, randomBytes } from 'crypto'
import { hex } from '@scure/base'
import {
  ArkAddress,
  ArkInfo,
  ArkTxInput,
  buildOffchainTx,
  CSVMultisigTapscript,
  decodeTapscript,
  Transaction,
  VtxoScript,
  ConditionWitness,
  setArkPsbtField,
  getArkPsbtFields,
  TapLeafScript,
} from '@arkade-os/sdk'

const TAP_LEAF_VERSION = 0xc0

/** Compute TapLeaf hash: SHA256(SHA256("TapLeaf") || SHA256("TapLeaf") || version || compactSize(script) || script) */
function tapLeafHash(script: Uint8Array, version: number): Uint8Array {
  const tag = createHash('sha256').update('TapLeaf').digest()
  const h = createHash('sha256')
  h.update(tag)
  h.update(tag)
  h.update(Buffer.from([version]))
  // compactSize encoding for script length
  if (script.length < 253) {
    h.update(Buffer.from([script.length]))
  } else if (script.length < 0x10000) {
    h.update(Buffer.from([253, script.length & 0xff, (script.length >> 8) & 0xff]))
  } else {
    h.update(Buffer.from([254, script.length & 0xff, (script.length >> 8) & 0xff, (script.length >> 16) & 0xff, (script.length >> 24) & 0xff]))
  }
  h.update(script)
  return new Uint8Array(h.digest())
}
import { CoinflipSetupScript, CoinflipFinalScript } from './script'
import { Game, VtxoInput } from './types'

function assertDefined<T>(value: T | undefined | null, name: string): asserts value is T {
  if (value === undefined || value === null) {
    throw new Error(`Missing ${name}`)
  }
}

/** Get the setup VtxoScript for a game */
export function getSetupScript(game: Game): CoinflipSetupScript {
  assertDefined(game.creator, 'creator')
  assertDefined(game.player, 'player')
  assertDefined(game.serverPubkey, 'serverPubkey')
  assertDefined(game.creator.hash, 'creator.hash')
  assertDefined(game.creator.pubkey, 'creator.pubkey')
  assertDefined(game.player.pubkey, 'player.pubkey')
  assertDefined(game.setupExpiration, 'setupExpiration')

  return new CoinflipSetupScript({
    creatorPubkey: game.creator.pubkey,
    playerPubkey: game.player.pubkey,
    serverPubkey: game.serverPubkey,
    creatorHash: game.creator.hash,
    setupExpiration: BigInt(game.setupExpiration),
  })
}

/** Get the final VtxoScript for a game */
export function getFinalScript(game: Game): CoinflipFinalScript {
  assertDefined(game.creator, 'creator')
  assertDefined(game.player, 'player')
  assertDefined(game.serverPubkey, 'serverPubkey')
  assertDefined(game.creator.hash, 'creator.hash')
  assertDefined(game.creator.pubkey, 'creator.pubkey')
  assertDefined(game.player.pubkey, 'player.pubkey')
  assertDefined(game.player.hash, 'player.hash')
  assertDefined(game.finalExpiration, 'finalExpiration')

  return new CoinflipFinalScript({
    creatorPubkey: game.creator.pubkey,
    playerPubkey: game.player.pubkey,
    serverPubkey: game.serverPubkey,
    creatorHash: game.creator.hash,
    playerHash: game.player.hash,
    finalExpiration: BigInt(game.finalExpiration),
  })
}

/** Get the ArkAddress for the setup output */
export function getSetupAddress(game: Game, networkHrp: string): ArkAddress {
  assertDefined(game.serverPubkey, 'serverPubkey')
  const script = getSetupScript(game)
  return script.address(networkHrp, game.serverPubkey)
}

/** Get the ArkAddress for the final output */
export function getFinalAddress(game: Game, networkHrp: string): ArkAddress {
  assertDefined(game.serverPubkey, 'serverPubkey')
  const script = getFinalScript(game)
  return script.address(networkHrp, game.serverPubkey)
}

/** Get the pot amount (2x bet) */
export function getPotAmount(game: Game): bigint {
  assertDefined(game.betAmount, 'betAmount')
  return 2n * game.betAmount
}

/**
 * Convert a VtxoInput to an ArkTxInput suitable for buildOffchainTx.
 */
function vtxoInputToArkTxInput(input: VtxoInput): ArkTxInput {
  const scripts = input.vtxo.tapscripts.map((s: string) => hex.decode(s))
  const vtxoScript = new VtxoScript(scripts)
  const leafScript = vtxoScript.findLeaf(input.leaf)

  return {
    txid: input.vtxo.outpoint.txid,
    vout: input.vtxo.outpoint.vout,
    value: Number(input.vtxo.amount),
    tapLeafScript: leafScript,
    tapTree: vtxoScript.encode(),
  }
}

/**
 * Build the setup and final transactions for a coinflip game.
 *
 * This replaces the old buildRedeemTx approach with SDK's buildOffchainTx.
 */
export function buildGameTransactions(
  game: Game,
  arkInfo: ArkInfo,
  networkHrp: string,
): { setup: Transaction; final: Transaction } {
  assertDefined(game.creator, 'creator')
  assertDefined(game.player, 'player')
  assertDefined(game.creator.vtxos, 'creator.vtxos')
  assertDefined(game.player.vtxos, 'player.vtxos')
  assertDefined(game.betAmount, 'betAmount')

  // Decode server unroll script from arkInfo
  const serverUnrollScript = decodeTapscript(
    hex.decode(arkInfo.checkpointTapscript)
  ) as CSVMultisigTapscript.Type

  // Build setup transaction inputs
  const allVtxoInputs = [...game.creator.vtxos, ...game.player.vtxos]
  const setupInputs = allVtxoInputs.map(vtxoInputToArkTxInput)

  // Build setup outputs
  const setupAddress = getSetupAddress(game, networkHrp)
  const potAmount = getPotAmount(game)

  const setupOutputs: { script: Uint8Array; amount: bigint }[] = [
    { script: setupAddress.pkScript, amount: potAmount },
  ]

  // Creator change
  const creatorSum = game.creator.vtxos.reduce(
    (acc, v) => acc + BigInt(v.vtxo.amount),
    0n
  )
  const creatorChange = creatorSum - game.betAmount
  if (creatorChange < 0n) throw new Error('Creator insufficient funds')
  if (creatorChange > 0n) {
    assertDefined(game.creator.changeAddress, 'creator.changeAddress')
    const changeAddr = ArkAddress.decode(game.creator.changeAddress)
    setupOutputs.push({ script: changeAddr.pkScript, amount: creatorChange })
  }

  // Player change
  const playerSum = game.player.vtxos.reduce(
    (acc, v) => acc + BigInt(v.vtxo.amount),
    0n
  )
  const playerChange = playerSum - game.betAmount
  if (playerChange < 0n) throw new Error('Player insufficient funds')
  if (playerChange > 0n) {
    assertDefined(game.player.changeAddress, 'player.changeAddress')
    const changeAddr = ArkAddress.decode(game.player.changeAddress)
    setupOutputs.push({ script: changeAddr.pkScript, amount: playerChange })
  }

  const { arkTx: setup } = buildOffchainTx(setupInputs, setupOutputs, serverUnrollScript)

  // Apply existing signatures to setup tx if present
  applySetupSignatures(setup, game)

  // Build final transaction
  const setupScript = getSetupScript(game)
  const finalInput: ArkTxInput = {
    txid: setup.id!,
    vout: 0,
    value: Number(potAmount),
    tapLeafScript: setupScript.reveal(),
    tapTree: setupScript.encode(),
  }

  const finalAddress = getFinalAddress(game, networkHrp)
  const finalOutputs = [{ script: finalAddress.pkScript, amount: potAmount }]
  const { arkTx: finalTx } = buildOffchainTx([finalInput], finalOutputs, serverUnrollScript)

  // Apply existing final signatures
  applyFinalSignatures(finalTx, game, setupScript)

  return { setup, final: finalTx }
}

function getLeafHash(leaf: TapLeafScript): Uint8Array {
  const scriptWithVersion = leaf[1]
  const script = scriptWithVersion.slice(0, -1)
  return tapLeafHash(script, TAP_LEAF_VERSION)
}

function applySetupSignatures(tx: Transaction, game: Game): void {
  const creator = game.creator!
  const player = game.player!

  if (creator.setupTxSignatures?.length) {
    for (let i = 0; i < creator.setupTxSignatures.length; i++) {
      const inputLeaf = tx.getInput(i).tapLeafScript?.[0]
      if (!inputLeaf) continue
      tx.updateInput(i, {
        tapScriptSig: [[
          { pubKey: creator.pubkey!, leafHash: getLeafHash(inputLeaf) },
          creator.setupTxSignatures[i],
        ]],
      })
    }
  }

  if (player.setupTxSignatures?.length) {
    const offset = creator.vtxos!.length
    for (let i = 0; i < player.setupTxSignatures.length; i++) {
      const inputLeaf = tx.getInput(offset + i).tapLeafScript?.[0]
      if (!inputLeaf) continue
      tx.updateInput(offset + i, {
        tapScriptSig: [[
          { pubKey: player.pubkey!, leafHash: getLeafHash(inputLeaf) },
          player.setupTxSignatures[i],
        ]],
      })
    }
  }
}

function applyFinalSignatures(
  tx: Transaction,
  game: Game,
  setupScript: CoinflipSetupScript
): void {
  const revealLeaf = setupScript.reveal()
  const leafHash = getLeafHash(revealLeaf)

  const sigs: [{ pubKey: Uint8Array; leafHash: Uint8Array }, Uint8Array][] = []

  if (game.creator?.finalTxSignature) {
    sigs.push([{ pubKey: game.creator.pubkey!, leafHash }, game.creator.finalTxSignature])
  }
  if (game.player?.finalTxSignature) {
    sigs.push([{ pubKey: game.player.pubkey!, leafHash }, game.player.finalTxSignature])
  }

  if (sigs.length > 0) {
    tx.updateInput(0, { tapScriptSig: sigs })
  }
}

/**
 * Determine the winner of a coinflip game.
 * Same size = player wins, different size = creator wins.
 * Valid sizes are 15 (heads) or 16 (tails) bytes.
 */
export function determineWinner(
  creatorSecret: Uint8Array,
  playerSecret: Uint8Array
): 'creator' | 'player' {
  const validSizes = [15, 16]
  if (!validSizes.includes(creatorSecret.length)) return 'player'
  if (!validSizes.includes(playerSecret.length)) return 'creator'
  return creatorSecret.length === playerSecret.length ? 'player' : 'creator'
}

/**
 * Generate a random secret for choosing heads or tails.
 * Heads = 15 bytes, Tails = 16 bytes.
 */
export function generateSecret(choice: 'heads' | 'tails'): Uint8Array {
  const length = choice === 'heads' ? 15 : 16
  return randomBytes(length)
}

/**
 * Add condition witness (secrets) to a transaction for cashout.
 */
export function addConditionWitness(
  tx: Transaction,
  inputIndex: number,
  witnesses: Uint8Array[]
): void {
  setArkPsbtField(tx, inputIndex, ConditionWitness, witnesses)
}

/**
 * Get condition witness from a transaction.
 */
export function getConditionWitness(
  tx: Transaction,
  inputIndex: number
): Uint8Array[] | undefined {
  const witnesses = getArkPsbtFields(tx, inputIndex, ConditionWitness)
  return witnesses.length > 0 ? witnesses[0] : undefined
}
