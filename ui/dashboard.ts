import {mount} from 'svelte';
import Dashboard from './Dashboard.svelte';
import './dashboard.css';
import './pwa/register.js';

mount(Dashboard, {target: document.getElementById('app')!});
