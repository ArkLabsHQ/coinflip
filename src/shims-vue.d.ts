declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent
  export default component
}

// 3D dice library ships no types; the Dice skin uses it dynamically.
declare module '@3d-dice/dice-box-threejs' {
  export default class DiceBox {
    constructor(selector: string, options: Record<string, unknown>)
    initialize(): Promise<void>
    clearDice(): void
    roll(notation: string): unknown
  }
}
