<template>
  <base-modal
    title="Create New Game"
    @close="$emit('close')"
  >
    <div class="create-form">
      <div class="form-group">
        <label>Game Amount</label>
        <div class="amount-input">
          <input 
            type="number" 
            v-model="amount"
            :placeholder="unitPlaceholder"
            :step="unitStep"
            :min="minAmount"
          >
          <button 
            class="unit-toggle" 
            @click="toggleUnit"
          >
            {{ unit }}
          </button>
        </div>
        <div class="usd-value" v-if="parseFloat(displayAmount) > 0">
          ≈ ${{ usdAmount }}
        </div>
        <div class="dust-warning" v-if="showDustWarning">
          Minimum amount is {{ minAmount }} {{ unit }}
        </div>
        <div class="balance-warning" v-if="showBalanceWarning">
          Insufficient balance. You have {{ formatBalance }} {{ unit }}
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
    const btcPrice = computed(() => store.state.btcPrice)
    const isSats = ref<boolean>(true)

    const unit = computed(() => isSats.value ? 'SATS' : 'BTC')
    const unitStep = computed(() => isSats.value ? '1' : '0.00000001')
    const unitPlaceholder = computed(() => isSats.value ? '0' : '0.00000000')

    const displayAmount = computed(() => {
      if (!amount.value) return '0'
      return isSats.value 
        ? (parseFloat(amount.value) / 100000000).toString()
        : amount.value
    })

    const toggleUnit = () => {
      if (!amount.value) {
        isSats.value = !isSats.value
        return
      }

      // Convert between sats and BTC while maintaining value
      const currentValue = parseFloat(amount.value)
      amount.value = isSats.value
        ? (currentValue / 100000000).toString() // sats to BTC
        : Math.floor(currentValue * 100000000).toString() // BTC to sats
      isSats.value = !isSats.value
    }

    const isValid = computed(() => {
      const numAmount = isSats.value 
        ? parseFloat(amount.value) 
        : parseFloat(amount.value) * 100000000
      const balance = store.getters['ark/balance']
      const dust = store.getters['ark/dust']
      return !isNaN(numAmount) && 
             BigInt(Math.floor(numAmount)) >= BigInt(dust || 1000) && 
             BigInt(Math.floor(numAmount)) <= balance
    })

    const usdAmount = computed(() => {
      if (!displayAmount.value || !btcPrice.value) return '0.00'
      return (parseFloat(displayAmount.value) * btcPrice.value).toFixed(2)
    })

    const minAmount = computed(() => {
      const dust = store.getters['ark/dust']
      return isSats.value 
        ? dust.toString()
        : (dust / 100000000).toFixed(8)
    })

    const showDustWarning = computed(() => {
      const numAmount = isSats.value 
        ? parseFloat(amount.value)
        : parseFloat(amount.value) * 100000000
      const dust = store.getters['ark/dust']
      return !isNaN(numAmount) && BigInt(Math.floor(numAmount)) < BigInt(dust || 1000)
    })

    const showBalanceWarning = computed(() => {
      const numAmount = isSats.value 
        ? parseFloat(amount.value)
        : parseFloat(amount.value) * 100000000
      const balance = store.getters['ark/balance']
      return !isNaN(numAmount) && BigInt(Math.floor(numAmount)) > balance
    })

    const formatBalance = computed(() => {
      const balance = store.getters['ark/balance']
      return isSats.value 
        ? balance.toString()
        : (Number(balance) / 100000000).toFixed(8)
    })

    const createGame = async () => {
      if (!isValid.value) return

      const now = Math.floor(Date.now() / 1000)
      const expirySeconds = 10 * 60 // 10 minutes in seconds
      const setupExpiration = now + Math.floor(expirySeconds / 2)
      const finalExpiration = now + Math.floor(expirySeconds)

      const betAmount = BigInt(Math.floor(isSats.value 
        ? parseFloat(amount.value)
        : parseFloat(amount.value) * 100000000))

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
      isValid,
      usdAmount,
      createGame,
      minAmount,
      showDustWarning,
      showBalanceWarning,
      formatBalance,
      unit,
      unitStep,
      unitPlaceholder,
      toggleUnit,
      displayAmount
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
      display: flex;
      gap: 0.5rem;

      input {
        flex: 1;
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

      .unit-toggle {
        padding: 0.75rem 1rem;
        background: var(--background);
        border: 1px solid var(--border);
        border-radius: 0.5rem;
        color: var(--text);
        font-weight: 500;
        transition: all 0.2s;

        &:hover {
          background: var(--border);
        }
      }
    }

    .usd-value {
      margin-top: 0.5rem;
      font-size: 0.875rem;
      color: var(--text-light);
    }

    .dust-warning,
    .balance-warning {
      margin-top: 0.5rem;
      font-size: 0.875rem;
      color: var(--error);
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