import {mount, type Component} from 'svelte';
import './player.css';
import '../pwa/register.js';

/** Mounts a player page; `?no-canvas=1` runs it without a canvas, for diagnostics. */
export function mountPlayer(player: Component): void {
  if (new URLSearchParams(location.search).get('no-canvas') === '1')
    document.documentElement.classList.add('no-canvas');
  mount(player, {target: document.getElementById('app')!});
}
