import {defineConfig} from 'vite';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {runtimeModules} from './tools/static-runtime-modules.mjs';
import {progressiveWebApp} from './tools/static-pwa.mjs';

export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [runtimeModules(), svelte(), progressiveWebApp()],
  build: {
    target: 'es2022',
    outDir: 'site',
    emptyOutDir: true,
    sourcemap: false,
    rolldownOptions: {
      input: ['index.html', 'aokana.html', 'noah.html', 'assets.html', 'aokana-assets.html'],
    },
  },
});
