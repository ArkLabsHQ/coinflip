const { defineConfig } = require('@vue/cli-service')
const CopyPlugin = require('copy-webpack-plugin')
const path = require('path')

module.exports = defineConfig({
  transpileDependencies: true,
  configureWebpack: {
    plugins: [
      // Serve @3d-dice/dice-box-threejs' runtime assets (dice textures + hit
      // sounds) at /dice-assets/ so the Dice skin's DiceBox can load them.
      // Copied from node_modules at build time — not committed to the repo.
      new CopyPlugin({
        patterns: [
          {
            from: path.resolve(__dirname, 'node_modules/@3d-dice/dice-box-threejs/public'),
            to: 'dice-assets',
          },
        ],
      }),
    ],
  },
})
