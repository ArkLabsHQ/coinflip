<template>
  <base-modal
    title="Relay Settings"
    @close="$emit('close')"
  >
    <div class="relay-form">
      <div class="form-group">
        <label>Relay URL</label>
        <div class="input-group">
          <input 
            type="text" 
            v-model="newRelay"
            placeholder="relay.damus.io"
          >
          <button 
            @click="updateRelay" 
            :disabled="!isValidUrl"
            class="confirm-button"
          >
            Update
          </button>
        </div>
        <div class="error-message" v-if="showError">
          Please enter a valid relay URL
        </div>
        <div class="help-text">
          Examples: relay.damus.io, wss://relay.damus.io, ws://localhost:8080
        </div>
      </div>
    </div>
  </base-modal>
</template>

<script lang="ts">
import { ref, computed } from 'vue'
import { useStore } from 'vuex'
import BaseModal from './BaseModal.vue'

export default {
  name: 'RelaySettings',
  components: {
    BaseModal
  },
  emits: ['close'],
  setup(_: unknown, { emit }: { emit: (event: "close") => void }) {
    const store = useStore()
    const newRelay = ref(store.getters.nostrRelay)
    const showError = ref(false)

    const isValidUrl = computed(() => {
      try {
        // Allow raw hostnames
        if (/^[\w.-]+$/.test(newRelay.value)) {
          return true
        }
        
        const url = new URL(newRelay.value)
        return url.protocol === 'ws:' || url.protocol === 'wss:' || 
               url.protocol === 'http:' || url.protocol === 'https:'
      } catch {
        return false
      }
    })

    const updateRelay = async () => {
      if (!isValidUrl.value) {
        showError.value = true
        return
      }
      
      showError.value = false
      await store.dispatch('updateNostrRelay', newRelay.value)
      emit('close')
    }

    return {
      newRelay,
      isValidUrl,
      showError,
      updateRelay
    }
  }
}
</script>

<style lang="scss" scoped>
.relay-form {
  .form-group {
    margin-bottom: 1.5rem;

    label {
      display: block;
      margin-bottom: 0.5rem;
      color: var(--text);
      font-weight: 500;
    }

    .input-group {
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
    }

    .error-message {
      margin-top: 0.5rem;
      color: var(--danger);
      font-size: 0.875rem;
    }

    .help-text {
      margin-top: 0.5rem;
      color: var(--text-light);
      font-size: 0.875rem;
    }
  }
}
</style> 