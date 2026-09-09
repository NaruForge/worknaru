import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  root: 'web/design-prototype', base: './', plugins: [react()],
  cacheDir: '../../node_modules/.vite-prototype',
  build: { outDir: '../../.worknaru-test/design-prototype', emptyOutDir: true, sourcemap: false },
});
