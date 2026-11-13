import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.live.spec.ts'],
    dangerouslyIgnoreUnhandledErrors: false,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
})
