<template>
  <div class="status-badge" :class="status.toLowerCase()">
    {{ status }}
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue'

export default defineComponent({
  name: 'StatusBadge',
  props: {
    status: {
      type: String,
      required: true
    }
  }
})
</script>

<style lang="scss" scoped>
.status-badge {
  padding: 0.5rem 1.25rem;
  border-radius: 0.5rem;
  font-weight: 500;
  min-width: 140px;
  text-align: center;
  font-size: 0.875rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  justify-content: center;
  
  &::before {
    content: '';
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  &.created {
    background: #fef3c7;
    color: #92400e;
    &::before {
      background: #92400e;
    }
  }

  &.joined {
    background: #dbeafe;
    color: #1e40af;
    &::before {
      background: #1e40af;
    }
  }

  &.setupstarted,
  &.setupfinalized {
    background: #dcfce7;
    color: #166534;
    &::before {
      background: #166534;
    }
  }

  &.completed {
    background: #e0e7ff;
    color: #3730a3;
    &::before {
      background: #3730a3;
    }
  }

  &.unknown {
    background: #f3f4f6;
    color: #6b7280;
    &::before {
      background: #6b7280;
    }
  }

  &.pending {
    background: #fef3c7;
    color: #92400e;
    &::before {
      background: #92400e;
    }
  }

  &.active {
    background: #dcfce7;
    color: #166534;
    &::before {
      background: #166534;
    }
  }
}
</style> 