import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import store from './store'

// Add smooth transition for theme changes
const style = document.createElement('style')
style.textContent = `
  * {
    transition: background-color 0.3s ease, border-color 0.3s ease;
  }
`
document.head.appendChild(style)

const app = createApp(App)
app.use(router)
app.use(store)
app.mount('#app') 