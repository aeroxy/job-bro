import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './App'

import '@/assets/index.css'

const syncDarkMode = () => {
  document.documentElement.classList.toggle(
    'dark',
    matchMedia('(prefers-color-scheme: dark)').matches
  )
}
syncDarkMode()
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncDarkMode)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
