declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

// 3D dice library ships no types; the Dice skin uses it dynamically.
declare module '@3d-dice/dice-box-threejs' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const DiceBox: any
  export default DiceBox
}
