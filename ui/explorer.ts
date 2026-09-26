import {mount} from 'svelte';
import Explorer from './Explorer.svelte';
import './explorers/explorer.css';
import './explorers/buriko.css';
import './pwa/register.js';

const game = /(?:buriko|aokana)-assets\.html$/i.test(location.pathname) ? 'buriko' : 'noah';
const target = document.getElementById('app');
if (!target) throw new Error('Missing explorer mount point');
mount(Explorer, {target, props: {game}});

// The controllers own inspector behavior and media elements. Svelte owns the page shell.
const controller =
  game === 'buriko' ? import('./explorers/buriko.js') : import('./explorers/noah.js');
void controller.catch((error: unknown) => {
  const status = target.querySelector<HTMLElement>('#status');
  if (status)
    status.textContent = `Could not start the asset explorer: ${error instanceof Error ? error.message : String(error)}`;
});
