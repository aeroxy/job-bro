import tailwindcss from '@tailwindcss/vite'
import { mkdirSync, readFileSync } from 'node:fs'
import { defineConfig } from 'wxt'

const chromeProfile = '.wxt/chrome-data'
mkdirSync(chromeProfile, { recursive: true })

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'))

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  webExt: {
    chromiumProfile: chromeProfile,
    keepProfileChanges: true,
    chromiumArgs: ['--hide-crash-restore-bubble'],
  },
  vite: () => ({
    plugins: [tailwindcss()],
    define: {
      __VERSION__: JSON.stringify(pkg.version),
    },
    build: {
      minify: false,
    },
  }),
  manifest: {
    name: 'Job Bro',
    description: 'AI-powered LinkedIn job posting analyzer',
    permissions: ['sidePanel', 'storage', 'activeTab', 'tabs', 'scripting'],
    host_permissions: [
      '*://www.linkedin.com/*',
      '*://*.fcapp.run/*',
      '*://api.openai.com/*',
      '*://openrouter.ai/*',
      '*://api.anthropic.com/*',
      '*://api.groq.com/*',
      '*://api.mistral.ai/*',
      '*://generativelanguage.googleapis.com/*',
      '*://api.cohere.com/*',
      '*://api.together.xyz/*',
      '*://api.fireworks.ai/*',
    ],
    icons: {
      64: 'assets/icon-64.png',
    },
    action: {
      default_title: 'Open Job Bro',
    },
    side_panel: {
      default_path: 'sidepanel/index.html',
    },
  },
})
