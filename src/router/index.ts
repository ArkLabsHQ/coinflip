import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import GameView from '../views/GameView.vue'
import WalletView from '../views/WalletView.vue'
import SetupView from '../views/SetupView.vue'
import store from '../store'

const routes: Array<RouteRecordRaw> = [
  {
    path: '/',
    name: 'home',
    component: HomeView,
    meta: { requiresWallet: true }
  },
  {
    path: '/game/:id',
    name: 'game',
    component: GameView,
    meta: { requiresWallet: true }
  },
  {
    path: '/wallet',
    name: 'wallet',
    component: WalletView,
    meta: { requiresWallet: true }
  },
  {
    path: '/setup',
    name: 'setup',
    component: SetupView
  },
  {
    path: '/how-it-works',
    name: 'how-it-works',
    component: () => import('../views/HowItWorksView.vue')
  }
]

const router = createRouter({
  history: createWebHistory(process.env.BASE_URL),
  routes
})

router.beforeEach((to, from, next) => {
  if (to.meta.requiresWallet && !store.getters.isWalletInitialized) {
    next('/setup')
  } else {
    next()
  }
})

export default router 