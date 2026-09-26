import {mount} from 'svelte';
import Player from './Player.svelte';
import './player/player.css';
import './player/aokana.css';
import './pwa/register.js';

const game = location.pathname.endsWith('/aokana.html') ? 'aokana' : 'noah';
if (new URLSearchParams(location.search).get('no-canvas') === '1')
  document.documentElement.classList.add('no-canvas');
mount(Player, {target: document.getElementById('app')!, props: {game}});
