import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import macros from 'unplugin-parcel-macros';
import { reactAriaOwnerWindow } from './build/react-aria-owner-window.mjs';
export default defineConfig({
  base: './',
  plugins: [
    reactAriaOwnerWindow(),
    macros.vite(),
    // Spectrum's default font loader injects Typekit scripts. This offline desktop app uses system fonts.
    {
      name: 'spectrum-system-fonts',
      enforce: 'pre',
      load(id) {
        if (id.replaceAll('\\', '/').endsWith('/@react-spectrum/s2/dist/private/Fonts.mjs'))
          return 'export function Fonts() { return null; }';
      },
    },
    react(),
  ],
  worker: { rollupOptions: { output: { entryFileNames: 'assets/worker-[hash].js' } } },
  // Keep these modules available to the same owner-window transform during development.
  optimizeDeps: { exclude: ['react-aria', '@react-spectrum/s2/style'] },
  server: { proxy: { '/api': 'http://127.0.0.1:5248' } },
  build: {
    target: 'es2022',
    cssMinify: 'lightningcss',
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        // Windows PRI interprets dotted worker basenames (including Monaco) as qualifiers.
        assetFileNames(asset) {
          return asset.names?.some(name => name.includes('.worker'))
            ? 'assets/runtimeWorker[hash][extname]'
            : 'assets/[name]-[hash][extname]';
        },
        chunkFileNames(chunk) {
          return chunk.name.includes('.worker') ? 'assets/runtimeWorker-[hash].js' : 'assets/[name]-[hash].js';
        },
        manualChunks(id) {
          if (/macro-(.*)\.css$/.test(id) || /@react-spectrum\/s2\/.*\.css$/.test(id)) return 'spectrum-styles';
        },
      },
    },
  },
});
