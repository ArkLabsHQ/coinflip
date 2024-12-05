import { Buffer } from 'buffer'

// Make Buffer available globally
window.Buffer = Buffer

// Declare Buffer on window
declare global {
  interface Window {
    Buffer: typeof Buffer
  }
}

export { Buffer } 