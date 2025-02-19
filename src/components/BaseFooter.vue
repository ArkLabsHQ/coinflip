<template>
  <footer class="base-footer">
    <div class="footer-content">
      <div class="footer-links">
        <router-link to="/how-it-works" @click="scrollToTop">
          <span class="material-icons link-icon">help_outline</span>
          How it Works
        </router-link>
      </div>
      <div class="footer-copyright">
        © {{ currentYear }} ArkLabs. All rights reserved.
      </div>
    </div>
  </footer>
</template>

<script setup lang="ts">
const currentYear = new Date().getFullYear();

const scrollToTop = () => {
  window.scrollTo({
    top: 0,
    behavior: 'smooth'
  });
};
</script>

<style lang="scss" scoped>
.base-footer {
  margin-top: auto;
  padding: 2.5rem 1.5rem;
  border-top: 1px solid var(--border);
  background-color: var(--background-alt);
  
  .footer-content {
    max-width: 1200px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1.5rem;
    
    .footer-links {
      display: flex;
      gap: 2rem;
      flex-wrap: wrap;
      justify-content: center;

      a {
        color: var(--text-light);
        text-decoration: none;
        font-weight: 500;
        font-size: 0.95rem;
        transition: color 0.2s ease;
        padding: 0.5rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        
        .link-icon {
          font-size: 1.1rem;
          margin-top: 1px;
        }
        
        &:hover {
          color: var(--primary);
        }

        &.router-link-active {
          color: var(--primary);
        }
      }
    }

    .footer-copyright {
      color: var(--text-lighter);
      font-size: 0.85rem;
    }
  }
}

@media (max-width: 768px) {
  .base-footer {
    padding: 2rem 1rem;
    
    .footer-content {
      gap: 1rem;
      
      .footer-links {
        gap: 1.5rem;
      }
    }
  }
}
</style> 