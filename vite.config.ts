import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: resolve('src/renderer'),
  publicDir: resolve('public'),
  clearScreen: false,
  server: {
    // `tauri android dev` sets TAURI_DEV_HOST to the LAN address the device
    // loads from; the server must bind there (or 0.0.0.0) to be reachable.
    host: process.env.TAURI_DEV_HOST || '127.0.0.1',
    port: 1420,
    strictPort: true
  },
  build: {
    outDir: resolve('dist'),
    emptyOutDir: true
  },
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src')
    }
  },
  plugins: [react()]
})
