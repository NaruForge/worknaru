import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  cacheDir: '../node_modules/.vite',
  server: { host: '127.0.0.1', port: 5173, strictPort: true,
    fs: { strict: true, allow: ['web', 'src', 'node_modules'].map((directory) => resolve(directory)),
      deny: ['**/.env', '**/.env.*', '**/*.{crt,pem}', '**/.git/**', '**/.worknaru-*/**'],
    },
  },
  preview: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: '../dist/web', emptyOutDir: true, rollupOptions: { input: { main: resolve('web/index.html'), paseo: resolve('web/paseo.html') } } },
});
