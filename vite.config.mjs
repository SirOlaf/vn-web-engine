import {defineConfig} from 'vite';
import {svelte} from '@sveltejs/vite-plugin-svelte';
import {runtimeModules} from './tools/static-runtime-modules.mjs';
import {progressiveWebApp} from './tools/static-pwa.mjs';

export default defineConfig(({mode}) => {
  const profiling = mode === 'profile';
  const runtimeBuildId = `${profiling ? 'profile' : 'release'}-${new Date().toISOString()}`;
  return {
    define: {__VN_RUNTIME_BUILD_ID__: JSON.stringify(runtimeBuildId)},
    base: './',
    publicDir: false,
    plugins: [runtimeModules({allowSourceMaps: profiling}), svelte(), progressiveWebApp()],
    build: {
      target: 'es2022',
      outDir: profiling ? 'site-profile' : 'site',
      emptyOutDir: true,
      sourcemap: profiling,
      minify: profiling ? false : undefined,
      rolldownOptions: {
        output: {keepNames: profiling},
        input: [
          'index.html',
          'buriko.html',
          'noah.html',
          'rscript.html',
          'assets.html',
          'buriko-assets.html',
        ],
      },
    },
  };
});
