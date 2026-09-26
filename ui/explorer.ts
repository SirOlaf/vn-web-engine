import {mount} from 'svelte';
import Explorer from './Explorer.svelte';
import './explorers/explorer.css';
import './explorers/aokana.css';

const game = location.pathname.toLowerCase().endsWith('aokana-assets.html') ? 'aokana' : 'noah';
const target = document.getElementById('app');
if (!target) throw new Error('Missing explorer mount point');
mount(Explorer, {target, props: {game}});

// The controllers own inspector behavior and media elements. Svelte owns the page shell.
const controller =
  game === 'aokana' ? import('./explorers/aokana.js') : import('./explorers/noah.js');
void controller.catch((error: unknown) => {
  const status = target.querySelector<HTMLElement>('#status');
  if (status)
    status.textContent = `Could not start the asset explorer: ${error instanceof Error ? error.message : String(error)}`;
});
