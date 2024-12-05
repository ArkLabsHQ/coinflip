type ToastType = 'success' | 'error' | 'warning' | 'info'

// Add styles to document if not already present
const styleId = 'toast-styles'
if (!document.getElementById(styleId)) {
  const style = document.createElement('style')
  style.id = styleId
  style.textContent = `
    .toast {
      position: fixed;
      top: 1rem;
      right: 1rem;
      padding: 1rem 1.5rem;
      border-radius: 0.5rem;
      color: white;
      font-weight: 500;
      opacity: 0;
      transform: translateY(-1rem);
      transition: all 0.3s ease;
      z-index: 9999;
    }

    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }

    .toast-success {
      background-color: #10B981;
    }

    .toast-error {
      background-color: #FF0000;
    }

    .toast-warning {
      background-color: #F59E0B;
    }

    .toast-info {
      background-color: #3B82F6;
    }
  `
  document.head.appendChild(style)
}

function createToast(message: string, type: ToastType = 'info') {
  const toast = document.createElement('div')
  toast.className = `toast toast-${type}`
  toast.textContent = message
  
  document.body.appendChild(toast)
  
  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add('show')
  })
  
  // Remove after delay
  setTimeout(() => {
    toast.classList.remove('show')
    setTimeout(() => toast.remove(), 300) // Wait for fade out
  }, 3000)
}

export const toast = {
  success: (message: string) => createToast(message, 'success'),
  error: (message: string) => createToast(message, 'error'),
  warning: (message: string) => createToast(message, 'warning'),
  info: (message: string) => createToast(message, 'info')
} 