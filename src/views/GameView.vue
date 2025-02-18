<template>
  <div class="game-view">
    <div class="nav-header">
      <button class="back-button" @click="goBack">
        <span class="material-icons">arrow_back</span>
        Back to Games
      </button>
    </div>

    <div class="game-container">
      <div class="game-header">
        <div class="game-title">
          <h3>Game</h3>
          <div class="game-id">
            <span class="hash">{{ gameId }}</span>
          </div>
        </div>
        <StatusBadge :status="gameStatus"></StatusBadge>
      </div>

      <div class="game-details">
        <div class="players">
          <div class="player">
            <h3>Creator</h3>
            <div class="address" v-if="game?.creator?.pubkey">
              <div class="role-badge" v-if="isCreator">You</div>
              {{ formatPubkey(game.creator.pubkey) }}
            </div>
          </div>
          <div class="vs">
            <div class="vs-circle">
              <span>VS</span>
            </div>
          </div>
          <div class="player">
            <h3>Opponent</h3>
            <div class="address" v-if="game?.player?.pubkey">
              <div class="role-badge" v-if="isPlayer">You</div>
              {{ formatPubkey(game.player.pubkey) }}
            </div>
          </div>
        </div>

        <div class="bet-amount">
          <h3>Pot Amount</h3>
          <div class="amount">{{ formattedPotAmount }}</div>
          <div class="bet-size">
            2 x {{ formatBTC(game?.betAmount) }} BTC 
          </div>
        </div>

        <div class="game-actions">
          <div class="action-buttons">
            <!-- Join Game - Only for non-participants when game is Created -->
            <div v-if="gameStatus === 'Created'" class="join-options">
              <h4>Choose Your Side</h4>
              <div class="choice-buttons">
                <button 
                  class="choice-button"
                  :class="{ disabled: !canJoin }"
                  @click="() => canJoin && joinGame(15)"
                  :disabled="!canJoin"
                  :title="canJoin ? 'Join with Heads (15 bytes)' : 'You cannot join this game'">
                  <span class="material-icons">face</span>
                  Heads
                </button>
                <button 
                  class="choice-button"
                  :class="{ disabled: !canJoin }"
                  @click="() => canJoin && joinGame(16)"
                  :disabled="!canJoin"
                  :title="canJoin ? 'Join with Tails (16 bytes)' : 'You cannot join this game'">
                  <span class="material-icons">currency_bitcoin</span>
                  Tails
                </button>
              </div>
              <div v-if="isCreator" class="status-message">
                Waiting for an opponent to join...
              </div>
            </div>
            
            <!-- Setup Started - Only for creator when game is Joined -->
            <template v-if="gameStatus === 'Joined'">
              <div v-if="isCreator" class="join-options">
                <h4>Choose Your Side</h4>
                <div class="choice-buttons">
                  <button 
                    class="choice-button"
                    @click="() => setupStart(15)"
                    :title="'Start setup with Heads (15 bytes)'">
                    <span class="material-icons">face</span>
                    Heads
                  </button>
                  <button 
                    class="choice-button"
                    @click="() => setupStart(16)"
                    :title="'Start setup with Tails (16 bytes)'">
                    <span class="material-icons">currency_bitcoin</span>
                    Tails
                  </button>
                </div>
              </div>
              <div v-else class="status-message">
                Waiting for creator to start setup...
              </div>
            </template>
            
            <!-- Setup Finalized - Only for player when game is SetupStarted -->
            <template v-if="gameStatus === 'Setup Started'">
              <button 
                v-if="isPlayer"
                @click="setupFinalize"
                :title="'Finalize the game setup'">
                Finalize Setup
              </button>
              <div v-else class="status-message">
                Waiting for opponent to finalize setup...
              </div>
            </template>
            
            <!-- Finalize - Only for creator when game is SetupFinalized -->
            <template v-if="gameStatus === 'Setup Finalized'">
              <button 
                v-if="isCreator"
                @click="finalize"
                :title="'Finalize the game'">
                Finalize Game
              </button>
              <div v-else class="status-message">
                Waiting for creator to finalize the game...
              </div>
            </template>
            
            <!-- Game completed - Show Play Game button and results -->
            <template v-if="gameStatus === 'Completed' || gameStatus === 'Resolved'">
              <!-- Show Play Game button for player when game is just completed -->
              <div v-if="gameStatus === 'Completed' && isPlayer" class="completed-actions">
                <button 
                  class="play-button"
                  @click="playGame"
                  :title="'Reveal your secret and see if you won'">
                  Play Game
                </button>
                <div class="help-text">
                  Reveal your secret to see if you won!
                </div>
              </div>
              <!-- Show Play Game button for creator when game is resolved -->
              <div v-else-if="gameStatus === 'Resolved' && isCreator && !winner" class="completed-actions">
                <button 
                  class="play-button"
                  @click="playGame"
                  :title="'Try to claim the funds'">
                  Play Game
                </button>
                <div class="help-text">
                  Player has revealed their secret - try to claim the funds!
                </div>
              </div>
              <!-- Show game result for resolved games with known winner -->
              <div v-else-if="gameStatus === 'Resolved' && winner" class="completed-message">
                <div class="game-result">
                  Game Resolved - 
                  <span class="winner" :class="{ 'is-you': 
                    (winner === 'creator' && isCreator) || 
                    (winner === 'player' && isPlayer) 
                  }">
                    {{ winner === 'creator' ? 'Creator' : 'Player' }} Won!
                  </span>
                </div>
              </div>
              <!-- Show completed message for non-participants -->
              <div v-else class="completed-message">
                Game {{ gameStatus === 'Resolved' ? 'Resolved' : 'Completed' }}
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { computed, ComputedRef } from 'vue'
import { useStore } from 'vuex'
import { useRoute, useRouter } from 'vue-router'
import { hex, base64 } from '@scure/base'
import type { State } from '@/store'
import { Game, getPotAmount, GameStatus, getTransactions, SetupStartedEvent, SetupFinalizedEvent, getSetupOutputAddress, cashoutTx, addConditionWitnessToTx } from '@/utils/game'
import StatusBadge from '@/components/StatusBadge.vue'
import { coinSelect, arkVtxoToInput } from '@/utils/coinselect'
import { toast } from '@/utils/toast'
import { ArkVTXO } from '@/store/modules/ark/ark'
import { sha256 } from '@scure/btc-signer/utils'
import { schnorr } from '@noble/curves/secp256k1';
import { VtxoInput } from '@/utils/psbt'
import { SigHash } from '@scure/btc-signer/transaction'
import { TAP_LEAF_VERSION } from '@scure/btc-signer/payment'

export default {
  name: 'GameView',
  components: {
    StatusBadge
  },
  setup() {
    const store = useStore<State>()
    const route = useRoute()
    const router = useRouter()
    const gameId = route.params.id as string

    const goBack = () => {
      router.push({ name: 'home' })
    }

    const game: ComputedRef<Game | undefined> = computed(() => 
      store.getters.games.find((g: Game) => g.gameId === gameId)
    )

    const gameStatus = computed(() => {
      if (!game.value?.status) return 'Unknown'
      switch (game.value.status) {
        case GameStatus.Created:
          return 'Created'
        case GameStatus.Joined:
          return 'Joined'
        case GameStatus.SetupStarted:
          return 'Setup Started'
        case GameStatus.SetupFinalized:
          return 'Setup Finalized'
        case GameStatus.Finalized:
          return 'Completed'
        case GameStatus.Resolved:
          return 'Resolved'
        default:
          return 'Unknown'
      }
    })

    const formatPubkey = (pubkey: Uint8Array) => {
      const hexPubkey = hex.encode(pubkey)
      return `${hexPubkey.slice(0, 6)}...${hexPubkey.slice(-4)}`
    }

    const formatBTC = (amount: bigint | undefined) => {
      if (!amount) return '0'
      return (Number(amount) / 100_000_000).toFixed(8)
    }

    const isCreator = computed(() => {
      if (!game.value?.creator?.pubkey || !store.state.wallet.publicKey) return false
      const playerPubkey = hex.decode(store.state.wallet.publicKey)
      return hex.encode(game.value.creator.pubkey) === hex.encode(playerPubkey)
    })

    const isPlayer = computed(() => {
      if (!game.value?.player?.pubkey || !store.state.wallet.publicKey) return false
      const playerPubkey = hex.decode(store.state.wallet.publicKey)
      return hex.encode(game.value.player.pubkey) === hex.encode(playerPubkey)
    })

    const canJoin = computed(() => {
      return !isCreator.value
    })

    const getRandomBytes = (size: 15 | 16) => {
      return crypto.getRandomValues(new Uint8Array(size))
    }

    const joinGame = async (secretSize: 15 | 16) => {
      try {
        if (!game.value?.betAmount) {
          throw new Error('Game bet amount not set')
        }

        if (secretSize !== 15 && secretSize !== 16) {
          throw new Error('Invalid secret size')
        }

        if (isCreator.value) {
          throw new Error('Only the opponent can join the game')
        }

        // Generate player's secret (15 or 16 bytes)
        const secret = getRandomBytes(secretSize)
        const secretHash = sha256(secret)

        // Get available UTXOs from ark store
        const vtxos = store.getters['ark/vtxos'] || []
        if (!store.state.wallet.publicKey || !store.getters.serverPubkey) {
          throw new Error('Wallet or server pubkey not available')
        }
        const walletPubkey = hex.decode(store.state.wallet.publicKey!)
        const serverPubkey = hex.decode(store.getters['ark/serverPubkey'].slice(2))

        // Convert ark VTXOs to VTXO inputs
        const vtxoInputs: VtxoInput[] = vtxos.map((vtxo: ArkVTXO) => 
          arkVtxoToInput(
            vtxo,
            walletPubkey,
            serverPubkey
          )
        )

        // Select UTXOs for the bet amount
        const { inputs } = coinSelect(vtxoInputs, game.value.betAmount)
        if (!inputs) {
          throw new Error('Insufficient funds to join game')
        }

        // Get change address from ark store
        const changeAddress = store.getters['ark/address']
        if (!changeAddress) {
          throw new Error('No change address available')
        }

        // Create and dispatch join event
        await store.dispatch('pushGameEvent', {
          type: 'join',
          gameId,
          playerPubkey: store.state.wallet.publicKey,
          playerVtxos: inputs,
          playerChangeAddress: changeAddress,
          playerHash: hex.encode(secretHash)
        })

        // Store secret for later reveal
        localStorage.setItem(`game_${gameId}_secret`, hex.encode(secret))

        toast.success('Successfully joined game')
      } catch (error) {
        console.error('Failed to join game:', error)
        toast.error(`Failed to join game: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    const setupStart = async (secretSize: 15 | 16) => {
      try {
        if (!game.value) {
          throw new Error('Game not found')
        }

        const signer = store.state.wallet.privateKey
        if (!signer) {
          throw new Error('Wallet not found')
        }

        // Generate creator's secret (15 or 16 bytes)
        const secret = getRandomBytes(secretSize)
        const secretHash = sha256(secret)

        const transactions = getTransactions({
          ...game.value,
          creator: {
            ...game.value.creator,
            hash: secretHash,
          }
        })

        const signedFinal = transactions.final.signIdx(hex.decode(signer), 0)
        if (!signedFinal) {
          throw new Error('Failed to sign final transaction')
        }

        let creatorSignature: string | undefined
        for (const [{ pubKey }, signature] of transactions.final.getInput(0).tapScriptSig || []) {
          if (hex.encode(pubKey) === hex.encode(store.getters['ark/walletPublicKey'])) {
            creatorSignature = hex.encode(signature)
          }
        }

        if (!creatorSignature) {
          throw new Error('Creator signature not found')
        }

        // Store secret for later reveal
        localStorage.setItem(`game_${gameId}_secret`, hex.encode(secret))

        const setupStartedEvent: SetupStartedEvent = {
          type: 'setupStarted',
          gameId,
          creatorHash: hex.encode(secretHash),
          creatorFinalSignature: creatorSignature
        }

        await store.dispatch('pushGameEvent', setupStartedEvent)
      } catch (error) {
        console.error('Failed to start setup:', error)
        toast.error(`Failed to start setup: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    const setupFinalize = async () => {
      try {
        if (!game.value) {
          throw new Error('Game not found')
        }

        const signer = store.state.wallet.privateKey
        if (!signer) {
          throw new Error('Wallet not found')
        }

        // Get transactions
        const transactions = getTransactions(game.value)

        // Verify creator's signature on final tx is valid
        const finalInput = transactions.final.getInput(0)
        const creatorSig = finalInput.tapScriptSig?.find(
          ([{ pubKey }]) => hex.encode(pubKey) === hex.encode(game.value!.creator!.pubkey!)
        )
        if (!creatorSig) {
          throw new Error('Creator signature not found on final transaction')
        }

        const [,reveal] = getSetupOutputAddress(game.value!)

        const msg = transactions.final.preimageWitnessV1(
          0,
          [finalInput.witnessUtxo!.script!],
          SigHash.DEFAULT,
          [finalInput.witnessUtxo!.amount],
          undefined,
          hex.decode(reveal),
          TAP_LEAF_VERSION
        )

        if (!schnorr.verify(creatorSig[1], msg, game.value!.creator!.pubkey!)) {
          throw new Error('Creator signature is invalid')
        }

        // Sign final transaction
        const signedFinal = transactions.final.signIdx(hex.decode(signer), 0)
        if (!signedFinal) {
          throw new Error('Failed to sign final transaction')
        }

        // Get player's signature from final transaction
        let playerFinalSignature: string | undefined
        for (const [{ pubKey }, signature] of transactions.final.getInput(0).tapScriptSig || []) {
          if (hex.encode(pubKey) === store.state.wallet.publicKey) {
            playerFinalSignature = hex.encode(signature)
          }
        }

        if (!playerFinalSignature) {
          throw new Error('Player signature not found')
        }

        // Sign setup transaction (only player's inputs)
        const creatorVtxosLength = game.value.creator?.vtxos?.length || 0
        const playerVtxos = game.value.player?.vtxos || []
        const playerSetupSignatures: string[] = []

        for (let i = 0; i < playerVtxos.length; i++) {
          const inputIndex = i + creatorVtxosLength

          const signed = transactions.setup.signIdx(hex.decode(signer), inputIndex)
          if (!signed) {
            throw new Error(`Failed to sign setup transaction input ${inputIndex}`)
          }

          // Get the signature from the signed input
          const input = transactions.setup.getInput(inputIndex)
          const tapScriptSig = input.tapScriptSig?.[0]
          if (!tapScriptSig) {
            throw new Error(`No signature found for input ${inputIndex}`)
          }

          playerSetupSignatures.push(hex.encode(tapScriptSig[1]))
        }


        const setupFinalizedEvent: SetupFinalizedEvent = {
          type: 'setupFinalized',
          gameId: game.value.gameId!,
          playerFinalSignature,
          playerSetupSignatures
        }

        // Dispatch the setupFinalized event
        await store.dispatch('pushGameEvent', setupFinalizedEvent)

        toast.success('Setup tx signed')
      } catch (error) {
        console.error('Failed to finalize setup:', error)
        toast.error(`Failed to finalize setup: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    const finalize = async () => {
      try {
        if (!game.value) {
          throw new Error('Game not found')
        }

        const secret = localStorage.getItem(`game_${game.value.gameId}_secret`)
        if (!secret) {
          throw new Error('Secret not found')
        }

        const signer = store.state.wallet.privateKey
        if (!signer) {
          throw new Error('Wallet not found')
        }

        // Get transactions
        const transactions = getTransactions(game.value)

        // Verify player's signature on final tx
        const finalInput = transactions.final.getInput(0)
        const playerSig = finalInput.tapScriptSig?.find(
          ([{ pubKey }]) => hex.encode(pubKey) === hex.encode(game.value!.player!.pubkey!)
        )
        if (!playerSig) {
          throw new Error('Player signature not found on final transaction')
        }

        // Verify player's signature is valid
        const [,reveal] = getSetupOutputAddress(game.value!)
        const msg = transactions.final.preimageWitnessV1(
          0,
          [finalInput.witnessUtxo!.script!],
          SigHash.DEFAULT,
          [finalInput.witnessUtxo!.amount],
          undefined,
          hex.decode(reveal),
          TAP_LEAF_VERSION
        )

        if (!schnorr.verify(playerSig[1], msg, game.value!.player!.pubkey!)) {
          throw new Error('Player signature is invalid')
        }

        // Sign setup transaction (only creator's inputs)
        const creatorVtxos = game.value.creator?.vtxos || []
        const creatorSetupSignatures: string[] = []

        for (let i = 0; i < creatorVtxos.length; i++) {
          const signed = transactions.setup.signIdx(hex.decode(signer), i)
          if (!signed) {
            throw new Error(`Failed to sign setup transaction input ${i}`)
          }

          // Get the signature from the signed input
          const input = transactions.setup.getInput(i)
          const tapScriptSig = input.tapScriptSig?.[0]
          if (!tapScriptSig) {
            throw new Error(`No signature found for input ${i}`)
          }
 
          creatorSetupSignatures.push(hex.encode(tapScriptSig[1]))
        }
      
        // Submit setup transaction to ark server
        const psbt = transactions.setup.toPSBT()
        const b64 = base64.encode(psbt)

        const finalPsbt = transactions.final.toPSBT()
        let finalB64 = base64.encode(finalPsbt)
        finalB64 = addConditionWitnessToTx(finalB64, 0, [hex.decode(secret)])

        console.log('final', finalB64)
        
        await store.dispatch('ark/broadcastRedeemTx', { redeemTx: b64 })
        await store.dispatch('ark/broadcastRedeemTx', { redeemTx: finalB64 })

        // only player dispatches the finalize event
        await store.dispatch('pushGameEvent', {
          type: 'finalize',
          gameId: game.value.gameId!,
          creatorSetupSignatures
        })

        toast.success('Game setup completed')
      } catch (error) {
        console.error('Failed to finalize game:', error)
        toast.error(`Failed to finalize game: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    const playGame = async () => {
      try {
        if (!game.value) {
          throw new Error('Game not found')
        }

        // Only allow the player to play when game is completed
        // or creator to play when game is resolved
        if (gameStatus.value === 'Completed' && !isPlayer.value) {
          throw new Error('Only the player can reveal their secret')
        }
        if (gameStatus.value === 'Resolved' && !isCreator.value) {
          throw new Error('Only the creator can claim at this point')
        }

        const secret = localStorage.getItem(`game_${game.value.gameId}_secret`)
        if (!secret) {
          throw new Error('Secret not found')
        }

        if (!store.state.wallet.privateKey || !store.state.wallet.publicKey) {
          throw new Error('Wallet not found')
        }

        const arkServerURL = store.getters['arkServer']
        if (!arkServerURL) {
          throw new Error('Ark server URL not found')
        }

        // Only dispatch resolve event if player is revealing
        if (isPlayer.value) {
          await store.dispatch('pushGameEvent', {
            type: 'resolve',
            gameId: game.value.gameId!,
            playerSecret: secret
          })
        }

        // Try to claim the funds
        const win = await cashoutTx(
          game.value,
          arkServerURL,
          isPlayer.value ? hex.decode(secret) : game.value.player!.revealedSecret!,
          hex.decode(store.state.wallet.privateKey),
          hex.decode(store.state.wallet.publicKey)
        )

        let winner = 'creator'
        if (isPlayer.value) {
          winner = win ? 'player' : 'creator'
        }
        if (isCreator.value) {
          winner = win ? 'creator' : 'player'
        }

        // persist if we won
        localStorage.setItem(
          `game_${game.value.gameId}_win`, 
          winner
        )


        if (win) {
          toast.success('You won! The funds have been sent to your address')
        } else {
          toast.error('You lost. Better luck next time!')
        }
      } catch (error) {
        console.error('Failed to play game:', error)
        toast.error(`Failed to play game: ${error instanceof Error ? error.message : 'Unknown error'}`)
      }
    }

    const formattedPotAmount = computed(() => {
      try {
        return formatBTC(game.value ? getPotAmount(game.value) : 0n)
      } catch (error) {
        console.error('Failed to get pot amount:', error)
        return '0'
      }
    })

    const isParticipant = computed(() => isCreator.value || isPlayer.value)

    const winner = computed(() => {
      if (!game.value || gameStatus.value !== 'Resolved') return null

      
      const winner = localStorage.getItem(`game_${game.value.gameId}_win`)
      console.log('winner', winner)
      return winner
    })

    return {
      gameId,
      game,
      gameStatus,
      isCreator,
      isPlayer,
      canJoin,
      formatPubkey,
      formatBTC,
      joinGame,
      playGame,
      goBack,
      getPotAmount,
      setupStart,
      setupFinalize,
      finalize,
      formattedPotAmount,
      isParticipant,
      winner,
    }
  }
}
</script>

<style lang="scss" scoped>
.game-view {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1rem;
}

.game-container {
  background: var(--card);
  border-radius: 1rem;
  padding: 1.5rem;
  box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1);
}

.game-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1.5rem;

  h4 {
    margin: 0;
  }

  .game-title {
    h3 {
      margin: 0 0 0.5rem 0;
      color: var(--text);
    }
    
    .game-id {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-family: monospace;
      
      .label {
        font-size: 0.75rem;
        font-weight: 500;
        color: var(--text-light);
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      
      .hash {
        font-size: 0.875rem;
        color: var(--primary);
        background: var(--background);
        padding: 0.25rem 0.5rem;
        border-radius: 0.25rem;
      }
    }
  }
}

.game-details {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.players {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 2rem;
  padding: 1.5rem;
  background: var(--background);
  border-radius: 0.5rem;

  .player {
    text-align: center;
    flex: 1;

    h3 {
      margin-bottom: 0.5rem;
    }

    .address {
      font-family: monospace;
      color: var(--text-light);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;

      .role-badge {
        background: var(--primary);
        color: white;
        padding: 0.125rem 0.5rem;
        border-radius: 1rem;
        font-size: 0.75rem;
        font-weight: 500;
        text-transform: uppercase;
      }
    }
  }

  .vs {
    position: relative;
    width: 60px;
    display: flex;
    justify-content: center;
    
    .vs-circle {
      width: 40px;
      height: 40px;
      background: var(--card);
      border: 2px solid var(--primary);
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      
      span {
        font-weight: 700;
        font-size: 0.875rem;
        color: var(--primary);
      }
    }
    
    &::before,
    &::after {
      content: '';
      position: absolute;
      top: 50%;
      width: 20px;
      height: 2px;
      background: var(--border);
    }
    
    &::before {
      left: 0;
    }
    
    &::after {
      right: 0;
    }
  }
}

.bet-amount {
  text-align: center;
  padding: 1rem;
  background: var(--background);
  border-radius: 0.5rem;

  h3 {
    margin-bottom: 0.5rem;
  }

  .amount {
    font-size: 1.5rem;
    font-weight: 700;
    color: var(--primary);
    margin-bottom: 0.25rem;
  }

  .bet-size {
    font-size: 0.875rem;
    color: var(--text-light);
  }
}

.game-actions {
  display: flex;
  justify-content: center;
  margin-top: 1rem;

  .action-buttons {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    
    button:not(.choice-button) {
      min-width: 200px;
      
      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }
    
    .completed-message {
      padding: 0.75rem 1.5rem;
      background: var(--background);
      border-radius: 0.5rem;
      color: var(--text-light);
      font-weight: 500;
    }
    
    .status-message {
      padding: 0.5rem 1rem;
      background: var(--background);
      border-radius: 0.5rem;
      color: var(--text-light);
      font-style: italic;
    }
  }
}

.nav-header {
  margin-bottom: 1rem;
}

.back-button {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  font-size: 0.875rem;
  color: var(--text-light);
  background: transparent;
  border: none;
  cursor: pointer;
  transition: color 0.2s;
  
  &:hover {
    color: var(--text);
  }
  
  .material-icons {
    font-size: 1.25rem;
  }
}

.join-options {
  text-align: center;
  padding: 0.75rem;
  
  h4 {
    margin: 0 0 0.75rem 0;
    color: var(--text);
    font-size: 1.1rem;
  }
  
  .choice-buttons {
    display: flex;
    gap: 1rem;
    justify-content: center;
    
    .choice-button {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem 2rem;
      border: 2px solid var(--primary);
      background: transparent;
      color: var(--primary);
      border-radius: 0.5rem;
      font-weight: 600;
      transition: all 0.2s;
      
      .material-icons {
        font-size: 1.25rem;
      }
      
      &:hover:not(.disabled) {
        background: var(--primary);
        color: white;
      }
      
      &.disabled {
        opacity: 0.5;
        cursor: not-allowed;
        border-color: var(--text-light);
        color: var(--text-light);
      }
    }
  }
  
  .status-message {
    margin-top: 1rem;
    color: var(--text-light);
    font-style: italic;
  }
}

.completed-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;

  .play-button {
    background: var(--primary);
    color: white;
    padding: 0.75rem 2rem;
    border-radius: 0.5rem;
    font-weight: 600;
    transition: all 0.2s;
    
    &:hover {
      background: var(--primary-dark);
    }
  }

  .help-text {
    font-size: 0.875rem;
    color: var(--text-light);
    font-style: italic;
  }
}

.completed-message {
  padding: 0.75rem 1.5rem;
  background: var(--background);
  border-radius: 0.5rem;
  color: var(--text-light);
  font-weight: 500;
}

.game-result {
  text-align: center;
  
  .winner {
    font-weight: 600;
    color: var(--text);
    
    &.is-you {
      color: var(--primary);
    }
  }
}
</style> 