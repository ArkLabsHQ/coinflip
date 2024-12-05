<template>
  <base-modal
    title="ARK Server Settings"
    @close="$emit('close')"
  >
    <div class="ark-form">
      <div class="form-group">
        <label>Server URL</label>
        <div class="input-group">
          <input 
            type="text" 
            v-model="newServer"
            placeholder="http://..."
          >
          <button 
            @click="updateServer" 
            :disabled="!isValidUrl"
            class="confirm-button"
          >
            Update
          </button>
        </div>
        <div class="error-message" v-if="showError">
          Please enter a valid HTTP URL (starting with http:// or https://)
        </div>
      </div>
    </div>
  </base-modal>
</template>

<script>
import { ref, computed } from 'vue'
import { useStore } from 'vuex'
import BaseModal from './BaseModal.vue'

export default {
  name: 'ArkSettings',
  components: {
    BaseModal
  },
  emits: ['close'],
  setup(props, { emit }) {
    const store = useStore()
    const newServer = ref(store.getters.arkServer)
    const showError = ref(false)

    const isValidUrl = computed(() => {
      try {
        const url = new URL(newServer.value)
        return url.protocol === 'http:' || url.protocol === 'https:'
      } catch {
        return false
      }
    })

    const updateServer = async () => {
      if (!isValidUrl.value) {
        showError.value = true
        return
      }
      
      await store.dispatch('ark/updateServer', newServer.value)
      emit('close')
    }

    return {
      newServer,
      isValidUrl,
      showError,
      updateServer
    }
  }
}
</script>

<style lang="scss" scoped>
.ark-form {
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
  }
}
</style> 