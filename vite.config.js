import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    host: true,
  },
  // Scoped to src/ — functions/ has its own Node-based test suite
  // (`node --test`, run via `npm test` inside functions/), since Cloud
  // Functions are CommonJS and run under Node, not Vite.
  test: {
    include: ['src/**/*.test.{js,jsx}'],
  },
})
