import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VUE_APP_')
  const base = process.env.BASE_URL || '/'
  return {
    base,
    plugins: [vue()],
    define: { global: 'globalThis', 'process.env': JSON.stringify({ ...env, BASE_URL: base, NODE_ENV: mode }) },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
      dedupe: ['vue', '@arkade-os/sdk'],
    },
    server: { proxy: { '/api': 'http://localhost:3001' } },
    optimizeDeps: {
      include: [
        'arkade-coinflip',
        ...['stake-math', 'bankroll', 'bankroll-vault', 'pool-game-vault', 'pool-input-renewal', 'pool-renewal-session', 'pool-batch-replay', 'arkade-win', 'joint-pot-tx', 'joint-pot', 'packets']
          .map(name => `arkade-coinflip/dist/${name}.js`),
      ],
    },
    build: {
      target: 'es2022',
      commonjsOptions: { include: [/node_modules/, /packages[\/]lib[\/]dist/] },
    },
  }
})
