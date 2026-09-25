import {mount} from 'svelte';
import Dashboard from './Dashboard.svelte';
import './dashboard.css';

mount(Dashboard, {target: document.getElementById('app')!});
