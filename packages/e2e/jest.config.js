const { compilerOptions } = require('./tsconfig.json')

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      useESM: false,
    }],
    '^.+\\.js$': ['ts-jest', {
      tsconfig: { ...compilerOptions, allowJs: true, isolatedModules: true },
      useESM: false,
    }],
  },
  // Transform ESM modules from these packages
  transformIgnorePatterns: [
    'node_modules/(?!(@scure|@arkade-os|@noble|@bitcoinerlab|@kukks|@marcbachmann|micro-packed|bip68|nostr-tools)/)',
  ],
  moduleFileExtensions: ['ts', 'js', 'json'],
  setupFiles: ['./src/setup.ts'],
}
