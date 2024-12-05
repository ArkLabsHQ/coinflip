<template>
  <base-modal
    title="Create New Game"
    @close="$emit('close')"
  >
    <div class="create-form">
      <div class="form-group">
        <label>Game Amount (BTC)</label>
        <div class="amount-input">
          <input 
            type="number" 
            v-model="amount"
            placeholder="0.00000000"
            step="0.00000001"
            min="0.00000001"
          >
        </div>
        <div class="usd-value" v-if="parseFloat(amount) > 0">
          ≈ ${{ usdAmount }}
        </div>
      </div>

      <div class="form-group">
        <label>Expires In</label>
        <div class="expiry-input">
          <select v-model="expiryHours">
            <option value="0.0833">5 minutes</option>
            <option value="0.1667">10 minutes</option>
            <option value="1">1 hour</option>
            <option value="6">6 hours</option>
            <option value="12">12 hours</option>
            <option value="24">24 hours</option>
            <option value="48">48 hours</option>
          </select>
        </div>
      </div>

      <div class="modal-actions">
        <button @click="$emit('close')" class="cancel-button">
          <span class="material-icons">close</span>
          Cancel
        </button>
        <button 
          @click="createGame"
          :disabled="!isValid"
          class="confirm-button"
        >
          <span class="material-icons">casino</span>
          Create Game
        </button>
      </div>
    </div>
  </base-modal>
</template>

<script lang="ts">
import { ref, computed, defineComponent } from 'vue'
import { useStore } from 'vuex'
import BaseModal from './BaseModal.vue'
import { coinSelect, arkVtxoToInput } from '../utils/coinselect'
import { hex } from '@scure/base'
import type { ArkVTXO } from '@/store/modules/ark/ark'
import { CreateEvent } from '@/utils/game'
export default defineComponent({
  name: 'CreateGameModal',
  components: {
    BaseModal
  },
  emits: ['close', 'created'],
  setup(props, { emit }) {
    const store = useStore()
    const amount = ref<string>('')
    const expiryHours = ref<string>('24')
    const btcPrice = computed(() => store.state.btcPrice)

    const isValid = computed(() => {
      const numAmount = parseFloat(amount.value)
      const balance = store.getters['ark/balance']
      return !isNaN(numAmount) && 
             numAmount >= 0.00000001 && 
             BigInt(Math.floor(numAmount * 100000000)) <= balance
    })

    const usdAmount = computed(() => {
      if (!amount.value || !btcPrice.value) return '0.00'
      return (parseFloat(amount.value) * btcPrice.value).toFixed(2)
    })

    const createGame = async () => {
      if (!isValid.value) return

      const now = Math.floor(Date.now() / 1000)
      const expirySeconds = parseFloat(expiryHours.value) * 60 * 60
      const setupExpiration = now + Math.floor(expirySeconds / 2)
      const finalExpiration = now + Math.floor(expirySeconds)

      const betAmount = BigInt(Math.floor(parseFloat(amount.value) * 100000000))
      const txFees = BigInt(300)

      const arkVtxos = store.getters['ark/vtxos']
      const walletPubkey = hex.decode(store.state.wallet.publicKey!)
      const serverPubkey = hex.decode(store.getters['ark/serverPubkey'].slice(2))
      
      const availableVtxos = arkVtxos.map((vtxo: ArkVTXO) => 
        arkVtxoToInput(vtxo, walletPubkey, serverPubkey)
      )
      
      const { inputs } = coinSelect(availableVtxos, betAmount)
      
      if (!inputs || inputs.length === 0) {
        console.error('Insufficient funds')
        return
      }

      const changeAddress = store.getters['ark/address']
      if (!changeAddress) {
        console.error('Failed to get change address')
        return
      }

      const gameId = crypto.randomUUID()
      const createEvent: CreateEvent = {
        type: 'create',
        gameId,
        creatorPubkey: store.state.wallet.publicKey!,
        creatorVtxos: inputs,
        creatorChangeAddress: changeAddress,
        betAmount: betAmount.toString(),
        txFees: txFees.toString(),
        serverPubkey: store.getters['ark/serverPubkey'],
        setupExpiration,
        finalExpiration
      }

      try {
        await store.dispatch('pushGameEvent', createEvent)
        emit('created')
      } catch (error) {
        console.error('Failed to create game:', error)
      }
    }

    return {
      amount,
      expiryHours,
      isValid,
      usdAmount,
      createGame
    }
  }
})
</script>

<style lang="scss" scoped>
.create-form {
  .form-group {
    margin-bottom: 1.5rem;

    label {
      display: block;
      margin-bottom: 0.5rem;
      color: var(--text);
      font-weight: 500;
    }

    .amount-input {
      input {
        width: 100%;
        padding: 0.75rem;
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        font-size: 1rem;
        font-family: monospace;
        transition: border-color 0.2s;

        &:focus {
          outline: none;
          border-color: var(--primary);
        }
      }
    }

    .usd-value {
      margin-top: 0.5rem;
      font-size: 0.875rem;
      color: var(--text-light);
    }
  }

  .expiry-input {
    select {
      width: 100%;
      padding: 0.75rem;
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      font-size: 1rem;
      background: var(--background);
      color: var(--text);
      transition: border-color 0.2s;

      &:focus {
        outline: none;
        border-color: var(--primary);
      }
    }
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
    margin-top: 2rem;

    button {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem 1.5rem;
      font-weight: 600;
      transition: all 0.2s ease;

      .material-icons {
        font-size: 1.25rem;
      }
    }

    .cancel-button {
      background: var(--background);
      color: var(--text);

      &:hover {
        background: var(--border);
      }
    }

    .confirm-button {
      background: var(--primary);

      &:hover:not(:disabled) {
        background: var(--primary-dark);
        transform: translateY(-1px);
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
      }

      &:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    }
  }
}
</style> 