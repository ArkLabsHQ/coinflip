module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/src/**/*.test.ts'],
  transform: {
    '^.+\\.[jt]s$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      useESM: false,
    }],
  },
  // Transform ESM modules from these packages
  transformIgnorePatterns: [
    'node_modules/(?!(@scure|@arkade-os|@noble|@bitcoinerlab|@kukks|@marcbachmann|micro-packed|bip68)/)',
  ],
  moduleFileExtensions: ['ts', 'js', 'json'],
}
