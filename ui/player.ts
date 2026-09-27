import {mount} from 'svelte';
import Player from './Player.svelte';
import './player/player.css';
import './player/buriko.css';
import './pwa/register.js';

const path = location.pathname;
const game = /\/buriko\.html$/i.test(path)
  ? 'buriko'
  : /\/rscript\.html$/i.test(path)
    ? 'rscript'
    : 'noah';
if (new URLSearchParams(location.search).get('no-canvas') === '1')
  document.documentElement.classList.add('no-canvas');
mount(Player, {target: document.getElementById('app')!, props: {game}});
