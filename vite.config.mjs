import {defineConfig} from 'vite';
import {svelte} from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist/ui',
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: {
      entry: 'ui/dashboard.ts',
      formats: ['es'],
      fileName: () => 'dashboard.js',
      cssFileName: 'dashboard',
    },
  },
});
