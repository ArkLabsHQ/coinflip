<template>
  <div class="wallet-view">
    <div class="wallet-container">
      <div class="balance-section">
        <div class="balance-card">
          <div class="balance-info">
            <span class="balance-label">Available Balance</span>
            <div class="balance-amount">
              ₿ {{ store.getters['ark/formattedBalance'] }}
              <div class="usd-value">
                ≈ ${{ usdBalance }}
              </div>
            </div>
          </div>
          <div class="balance-actions">
            <button @click="showWithdrawModal = true" class="withdraw-button">
              <span class="material-icons">logout</span>
              Withdraw
            </button>
          </div>
        </div>
      </div>

      <div class="deposit-section">
        <h2>Deposit</h2>
        <div class="address-card">
          <div class="qr-code" v-if="arkAddress">
            <img :src="`https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${arkAddress}`" alt="ARK Address QR Code"/>
          </div>
          <div class="address-details">
            <label>Address</label>
            <div class="address-container">
              <code class="address">{{ arkAddress || 'Generating address...' }}</code>
              <button @click="copyAddress" class="copy-button" :disabled="!arkAddress">
                <span class="material-icons">content_copy</span>
              </button>
            </div>
            <div v-if="isMutinyTestnet" class="faucet-container">
              <button @click="requestFaucet" class="faucet-button">
                <span class="material-icons">water_drop</span>
                Faucet
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="server-info-section">
        <h2>Ark Config</h2>
        <div class="info-card">
          <div class="info-grid">
            <div class="info-item network">
              <label>Network</label>
              <span>{{ store.getters['ark/serverNetwork'] || 'Unknown' }}</span>
            </div>
            <div class="info-item pubkey">
              <label>Server Pubkey</label>
              <code>{{ store.getters['ark/serverPubkey'] || 'Unknown' }}</code>
            </div>
          </div>
        </div>
      </div>

      <div class="danger-zone">
        <h2>Danger Zone</h2>
        <div class="danger-card">
          <div class="action-buttons">
            <button @click="showPrivateKey = true" class="danger-button">
              <span class="material-icons">key</span>
              Show Private Key
            </button>
            <button @click="showDeleteConfirm = true" class="danger-button">
              <span class="material-icons">delete_forever</span>
              Delete Wallet
            </button>
          </div>
        </div>
      </div>

      <base-modal
        v-if="showWithdrawModal"
        title="Withdraw Funds"
        @close="closeWithdrawModal"
      >
        <div class="withdraw-form">
          <div class="form-group">
            <label>Ark Address</label>
            <input 
              type="text" 
              v-model="withdrawAddress"
              placeholder="Enter Ark address"
            >
          </div>

          <div class="form-group">
            <label>Amount (BTC)</label>
            <div class="amount-input">
              <input 
                type="number" 
                v-model="withdrawAmount"
                step="0.00000001"
                min="0"
                :max="maxWithdrawAmount"
                placeholder="0.00000000"
              >
              <button @click="setMaxAmount" class="max-button">MAX</button>
            </div>
            <div class="available">
              ₿{{ store.getters['ark/formattedBalance'] }}
            </div>
          </div>

          <div class="modal-actions">
            <button @click="closeWithdrawModal" class="cancel-button">Cancel</button>
            <button 
              @click="withdrawFunds" 
              class="confirm-button"
            >
              Confirm Withdraw
            </button>
          </div>
        </div>
      </base-modal>

      <base-modal
        v-if="showPrivateKey"
        title="Your Private Key"
        @close="showPrivateKey = false"
      >
        <div class="private-key-display">
          <div class="warning">
            Never share your private key with anyone!
          </div>
          
          <div class="key-container">
            <code>{{ privateKey }}</code>
            <button @click="copyPrivateKey" class="copy-button">
              <span class="material-icons">content_copy</span>
            </button>
          </div>
        </div>
      </base-modal>

      <base-modal
        v-if="showDeleteConfirm"
        title="Delete Wallet"
        @close="showDeleteConfirm = false"
      >
        <div class="delete-confirmation">
          <div class="warning">
            <p>Are you sure you want to delete your wallet?</p>
            <p>This action cannot be undone. Make sure you have backed up your private key.</p>
          </div>
          
          <div class="confirmation-input">
            <label>Type "DELETE" to confirm:</label>
            <input 
              type="text"
              v-model="deleteConfirmText"
              placeholder="DELETE"
            >
          </div>
          
          <div class="modal-actions">
            <button @click="showDeleteConfirm = false" class="cancel-button">
              Cancel
            </button>
            <button 
              @click="deleteWallet"
              :disabled="deleteConfirmText !== 'DELETE'"
              class="danger-button"
            >
              Delete Wallet
            </button>
          </div>
        </div>
      </base-modal>
    </div>
  </div>
</template>

<script lang="ts">
import { computed, ref, onMounted, watch } from 'vue'
import { useStore } from 'vuex'
import { useRouter } from 'vue-router'
import BaseModal from '@/components/BaseModal.vue'
import { ArkAddress } from '@/store/modules/ark/address'
import { toast } from '@/utils/toast'
import { Buffer } from '@/utils/buffer'
import { buildRedeemTx, VtxoInput } from '@/utils/psbt'
import { ArkVTXO } from '@/store/modules/ark/ark'
import { base64 } from '@scure/base'

export default {
  name: 'WalletView',
  components: {
    BaseModal
  },
  setup() {
    const store = useStore()
    const router = useRouter()
    const balance = computed(() => store.getters.formattedBalance)
    const usdBalance = computed(() => store.getters.usdBalance)
    const publicKey = computed(() => store.state.wallet.publicKey)
    const serverPubkey = computed(() => store.state.ark.info?.pubkey)
    const arkAddress = computed(() => store.getters['ark/address'])
    const arkBalance = computed(() => store.getters['ark/balance'])

    // Generate address whenever server pubkey or wallet pubkey changes
    watch(
      [serverPubkey, publicKey],
      ([newServerPubkey, newPublicKey]) => {
        if (newServerPubkey && newPublicKey) {
          console.log('Generating address with pubkeys:', {
            wallet: newPublicKey,
            server: newServerPubkey
          })
          
          try {
            const pubkeyBuffer = Buffer.from(newPublicKey, 'hex')
            const serverPubkeyBuffer = Buffer.from(newServerPubkey.slice(2), 'hex')
            
            const address = ArkAddress.fromPubKey(pubkeyBuffer, serverPubkeyBuffer, 'testnet')
            console.log('Generated address:', address.encode())
          } catch (err) {
            console.error('Failed to generate address:', err)
          }
        }
      },
      { immediate: true } // Run immediately when component is mounted
    )

    const copyAddress = async () => {
      if (!arkAddress.value) return
      
      try {
        await navigator.clipboard.writeText(arkAddress.value)
        toast.success('Address copied to clipboard!')
      } catch (err) {
        console.error('Failed to copy address:', err)
        toast.error('Failed to copy address')
      }
    }

    const showWithdrawModal = ref(false)
    const withdrawAddress = ref('')
    const withdrawAmount = ref(0)
    const maxWithdrawAmount = computed(() => {
      const balanceSats = store.getters['ark/balance'] || BigInt(0)
      // Convert BigInt sats to BTC number
      return Number(balanceSats) / 100000000
    })
    const showPrivateKey = ref(false)
    const privateKey = computed(() => store.getters.walletPrivateKeyEncoded)
    const showDeleteConfirm = ref(false)
    const deleteConfirmText = ref('')

    const setMaxAmount = () => {
      const maxSats = store.getters['ark/balance'] || BigInt(0)
      if (maxSats > BigInt(300)) {
        withdrawAmount.value = Number(maxSats) / 100000000
      } else {
        withdrawAmount.value = 0
      }
    }

    const closeWithdrawModal = () => {
      showWithdrawModal.value = false
      withdrawAddress.value = ''
      withdrawAmount.value = 0
    }

    const withdrawFunds = async () => {
      try {
        // Get the private key from storage
        const privKey = store.getters.walletPrivateKey
        if (!privKey) {
          toast.error('Private key not found')
          return
        }

        const address = store.getters['ark/address']
        if (!address) {
          toast.error('Address not found')
          return
        }

        // Get selected VTXO
        const vtxos = store.getters['ark/vtxos'] as ArkVTXO[]
        if (!vtxos.length) {
          toast.error('No VTXO selected')
          return
        }

        // Convert BTC to sats - withdrawAmount is in BTC
        const amountSats = BigInt(Math.round(withdrawAmount.value * 100000000))

        if (amountSats < BigInt(300)) {
          toast.error('Amount is too small, need at least 300 sats')
          return
        }

        const selectedVtxos: VtxoInput[] = []
        let selectedAmount = BigInt(0)
        
        // Convert and sum VTXO amounts
        for (const vtxo of vtxos) {
          selectedVtxos.push({
            vtxo,
            leaf: vtxo.tapscripts[0]
          })
          selectedAmount += BigInt(vtxo.amount)
          if (selectedAmount >= amountSats) {
            break
          }
        }

        if (selectedAmount < amountSats) {
          toast.error(`Insufficient balance, need ${amountSats} sats`)
          return
        }

        const change = selectedAmount - amountSats

        const outputs = [{
          address: withdrawAddress.value,
          value: change <= BigInt(0) ? amountSats - BigInt(300) : amountSats
        }]

        if (change > BigInt(0)) {
          outputs.push({
            address,
            value: change - BigInt(300)
          })
        }

        console.log('outputs', outputs)
        // Create transaction
        const tx = buildRedeemTx(
          selectedVtxos,
          outputs
        )

        // Sign the transaction
        tx.sign(Buffer.from(privKey, 'hex'))
        
        // to psbt
        const psbt = tx.toPSBT()
        const b64 = base64.encode(psbt)
        const txid = await store.dispatch('ark/broadcastRedeemTx', { redeemTx: b64 })
        
        toast.success('Transaction created successfully')
        closeWithdrawModal()
        return txid

      } catch (error: unknown) {
        toast.error(`Failed to create transaction: ${error instanceof Error ? error.message : 'Unknown error'}`)
        throw error
      }
    }

    const copyPrivateKey = async () => {
      try {
        await navigator.clipboard.writeText(privateKey.value)
        alert('Private key copied!')
      } catch (err) {
        console.error('Failed to copy:', err)
      }
    }

    const deleteWallet = () => {
      store.dispatch('clearWallet')
      router.push('/setup')
    }

    const isMutinyTestnet = computed(() => 
      store.state.ark.server === 'https://mutinynet.arkade.sh'
    )

    const requestFaucet = async () => {
      if (!arkAddress.value) return
      
      try {
        const response = await fetch('https://faucet.mutinynet.arkade.sh/faucet', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            address: arkAddress.value,
            amount: 1000
          })
        })
        
        if (!response.ok) {
          throw new Error('Faucet request failed')
        }
        
        toast.success('Faucet request successful! Funds should arrive shortly.')
        
        // Reload VTXOs to update balance
        await store.dispatch('ark/fetchVTXOs')
      } catch (err) {
        console.error('Failed to request from faucet:', err)
        toast.error('Failed to request from faucet')
      }
    }

    onMounted(async () => {
      // Fetch server info if not already available
      if (!store.state.ark.info) {
        console.log('Fetching server info...')
        await store.dispatch('ark/checkConnection')
      }

      await store.dispatch('fetchBTCPrice')
    })

    return {
      balance,
      usdBalance,
      arkAddress,
      copyAddress,
      showWithdrawModal,
      withdrawAddress,
      withdrawAmount,
      maxWithdrawAmount,
      setMaxAmount,
      closeWithdrawModal,
      withdrawFunds,
      showPrivateKey,
      privateKey,
      copyPrivateKey,
      showDeleteConfirm,
      deleteConfirmText,
      deleteWallet,
      store,
      arkBalance,
      isMutinyTestnet,
      requestFaucet,
    }
  }
}
</script>

<style lang="scss" scoped>
.wallet-view {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem 1rem;

  @media (max-width: 768px) {
    padding: 1rem;
  }
}

.wallet-container {
  display: flex;
  flex-direction: column;
  gap: 2rem;
}

.balance-section {
  .balance-card {
    background: var(--card);
    border-radius: 1rem;
    padding: 2rem;
    box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 2rem;
    
    .balance-info {
      .balance-label {
        display: block;
        color: var(--text-light);
        font-size: 1rem;
        margin-bottom: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: 500;
      }

      .balance-amount {
        font-size: 2.5rem;
        font-weight: 700;
        color: var(--primary);
        letter-spacing: -0.02em;

        .usd-value {
          font-size: 1rem;
          color: var(--text-light);
          margin-top: 0.25rem;
          font-weight: 500;
        }
      }
    }

    .balance-actions {
      margin-top: 1.5rem;

      .withdraw-button {
        background: var(--background);
        color: var(--text);
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.75rem 1.5rem;
        font-weight: 600;
        transition: all 0.2s ease;
        
        &:hover {
          background: var(--border);
          transform: translateY(-1px);
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
        }

        .material-icons {
          font-size: 1.25rem;
        }
      }
    }

    @media (max-width: 768px) {
      flex-direction: column;
      text-align: center;
      
      .balance-info {
        .balance-amount {
          font-size: 2rem;
        }
      }
      
      .balance-actions {
        width: 100%;
        
        .withdraw-button {
          width: 100%;
          justify-content: center;
        }
      }
    }
  }
}

.deposit-section {
  background: var(--card);
  border-radius: 1rem;
  padding: 2rem;
  box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1);

  .address-card {
    margin-top: 1.5rem;
    display: flex;
    gap: 2rem;
    padding: 1.5rem;
    background: var(--background);
    border-radius: 0.5rem;
    align-items: center;
    
    @media (max-width: 768px) {
      flex-direction: column;
      align-items: center;
      gap: 1.5rem;
    }

    .qr-code {
      padding: 1rem;
      background: var(--card);
      border-radius: 0.75rem;
      box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
      img {
        width: 150px;
        height: 150px;
        border-radius: 0.25rem;
        display: block;
      }
    }

    .address-details {
      flex: 1;
      width: 100%;

      label {
        display: block;
        font-weight: 500;
        margin-bottom: 0.5rem;
        color: var(--text-light);
      }

      .address-container {
        display: flex;
        gap: 1rem;
        align-items: center;
        
        @media (max-width: 480px) {
          flex-direction: column;
          
          .address {
            font-size: 0.875rem;
          }
          
          .copy-button {
            width: 100%;
            padding: 0.75rem;
          }
        }

        .address {
          flex: 1;
          padding: 1rem;
          background: var(--card);
          border-radius: 0.5rem;
          font-family: monospace;
          word-break: break-all;
        }

        .copy-button {
          background: transparent;
          color: var(--text);
          padding: 0.5rem;
          min-width: auto;
          font-size: 1.25rem;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: opacity 0.2s;

          &:hover {
            opacity: 0.7;
          }
        }
      }
    }
  }
}

.amount-input {
  display: flex;
  gap: 0.5rem;

  input {
    flex: 1;
  }

  .max-button {
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    background: var(--background);
    color: var(--text);
    font-weight: 600;

    &:hover {
      background: var(--border);
    }
  }
}

.available {
  margin-top: 0.5rem;
  font-size: 0.875rem;
  color: var(--text-light);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 1rem;
  margin-top: 2rem;

  .cancel-button {
    background: var(--background);
    color: var(--text);
    font-weight: 600;

    &:hover {
      background: var(--border);
    }
  }

  .confirm-button {
    font-weight: 600;
  }
}

.withdraw-form {
  .form-group {
    margin-bottom: 1.5rem;

    label {
      display: block;
      margin-bottom: 0.5rem;
      color: var(--text);
      font-weight: 500;
    }

    input {
      width: 100%;
      padding: 0.75rem;
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      font-size: 1rem;
      transition: border-color 0.2s;

      &:focus {
        outline: none;
        border-color: var(--primary);
      }
    }
  }
}

.danger-zone {
  background: var(--card);
  border-radius: 1rem;
  padding: 2rem;
  box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1);

  h2 {
    color: var(--danger);
  }

  .danger-card {
    margin-top: 1.5rem;
    padding: 1.5rem;
    background: var(--background);
    border-radius: 0.5rem;
    
    .action-buttons {
      display: flex;
      gap: 1rem;
      
      .danger-button {
        background: var(--danger);
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        
        &:hover {
          background: #dc2626;
        }
      }
    }

    @media (max-width: 480px) {
      flex-direction: column;
      
      .action-buttons {
        flex-direction: column;
        
        .danger-button {
          width: 100%;
          justify-content: center;
        }
      }
    }
  }
}

.private-key-display {
  .warning {
    color: var(--danger);
    margin-bottom: 1rem;
    font-weight: 500;
  }
  
  .key-container {
    background: var(--background);
    padding: 1rem;
    border-radius: 0.5rem;
    display: flex;
    gap: 1rem;
    align-items: center;
    
    code {
      flex: 1;
      font-family: monospace;
      word-break: break-all;
    }
  }
}

.delete-confirmation {
  .warning {
    color: var(--danger);
    margin-bottom: 1.5rem;
    
    p {
      margin-bottom: 0.5rem;
      
      &:last-child {
        margin-bottom: 0;
      }
    }
  }
  
  .confirmation-input {
    margin-bottom: 1.5rem;
    
    label {
      display: block;
      margin-bottom: 0.5rem;
      font-weight: 500;
    }
    
    input {
      width: 100%;
      padding: 0.75rem;
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      font-family: monospace;
      
      &:focus {
        outline: none;
        border-color: var(--danger);
      }
    }
  }
  
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 1rem;
  }
}

.server-info-section {
  background: var(--card);
  border-radius: 1rem;
  padding: 2rem;
  box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1);

  .info-card {
    margin-top: 1.5rem;
    padding: 1.5rem;
    background: var(--background);
    border-radius: 0.5rem;

    .info-grid {
      display: grid;
      grid-template-columns: 150px 1fr;
      gap: 1.5rem;
      
      @media (max-width: 768px) {
        grid-template-columns: 1fr;
        gap: 1rem;
      }

      .info-item {
        &.network {
          min-width: auto;
        }

        &.pubkey {
          flex: 1;

          code {
            font-size: 0.75rem;
          }
        }

        label {
          display: block;
          font-weight: 500;
          margin-bottom: 0.5rem;
          color: var(--text-light);
        }

        span, code {
          display: block;
          padding: 0.5rem;
          background: var(--card);
          border-radius: 0.25rem;
          font-size: 0.875rem;
        }

        code {
          font-family: monospace;
          word-break: break-all;
        }
      }
    }
  }
}

.ark-balance {
  margin-top: 1rem;
  padding: 1rem;
  border: 1px solid #ddd;
  border-radius: 4px;
}

.faucet-container {
  margin-top: 1rem;
  display: flex;
  justify-content: center;
  
  .faucet-button {
    width: auto;
    background: var(--primary);
    color: white;
    padding: 0.5rem 1rem;
    font-size: 0.875rem;
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    transition: all 0.2s ease;
    
    &:hover {
      opacity: 0.9;
      transform: translateY(-1px);
    }
    
    .material-icons {
      font-size: 1rem;
    }
    
    @media (max-width: 480px) {
      width: 100%;
      padding: 0.75rem;
      font-size: 1rem;
      
      .material-icons {
        font-size: 1.25rem;
      }
    }
  }
}
</style> 