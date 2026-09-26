import {mount} from 'svelte';
import Player from './Player.svelte';
import './player/player.css';
import './player/buriko.css';
import './pwa/register.js';

const game = /\/(?:buriko|aokana)\.html$/i.test(location.pathname) ? 'buriko' : 'noah';
if (new URLSearchParams(location.search).get('no-canvas') === '1')
  document.documentElement.classList.add('no-canvas');
mount(Player, {target: document.getElementById('app')!, props: {game}});
