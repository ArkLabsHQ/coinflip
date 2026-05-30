import { createRouter, createWebHistory, RouteRecordRaw } from 'vue-router'
import PlayView from '../views/PlayView.vue'
import RocketView from '../views/RocketView.vue'
import WalletView from '../views/WalletView.vue'
import SetupView from '../views/SetupView.vue'
import HistoryView from '../views/HistoryView.vue'
import store from '../store'

const routes: Array<RouteRecordRaw> = [
  {
    path: '/',
    name: 'play',
    component: PlayView,
    meta: { requiresWallet: true }
  },
  {
    path: '/rocket',
    name: 'rocket',
    component: RocketView,
    meta: { requiresWallet: true }
  },
  {
    path: '/wallet',
    name: 'wallet',
    component: WalletView,
    meta: { requiresWallet: true }
  },
  {
    path: '/history',
    name: 'history',
    component: HistoryView,
    meta: { requiresWallet: true }
  },
  {
    path: '/setup',
    name: 'setup',
    component: SetupView
  },
]

const router = createRouter({
  history: createWebHistory(process.env.BASE_URL),
  routes
})

router.beforeEach((to, _from, next) => {
  if (to.meta.requiresWallet && !store.getters.isWalletInitialized) {
    next('/setup')
  } else {
    next()
  }
})

export default router
