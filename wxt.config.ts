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
      // Evaluated once at build start — lets the running worker print which
      // build it actually is, so a stale (un-reloaded) service worker is obvious.
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
    build: {
      minify: false,
    },
  }),
  manifest: {
    name: 'Job Bro',
    description: 'AI-powered LinkedIn job posting analyzer',
    permissions: ['sidePanel', 'storage', 'activeTab', 'tabs', 'scripting', 'offscreen', 'cookies', 'declarativeNetRequest'],
    host_permissions: [
      '*://*/*',
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
    web_accessible_resources: [
      {
        resources: ['spa-tracker.js'],
        matches: ['*://*.linkedin.com/*'],
      },
    ],
  },
})
