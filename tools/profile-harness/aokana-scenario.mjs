// Replays one Aokana test save through tools/profile-harness/controller.mjs and captures a
// sampling CPU profile plus the in-game timings JSON. Boot, startup skip and loading run at
// 1x; only the measured window is throttled. See docs/buriko-rendering-handoff.md.
//
//   node tools/profile-harness/aokana-scenario.mjs <slot 2|3|4> --out <prefix>
//     [--throttle 6] [--query bitmap-resident=0&bp-wasm=0] [--no-record] [--boot-record]
//     [--check] [--controller http://127.0.0.1:9444] [--origin http://127.0.0.1:8001]
//
// Writes <prefix>.cpuprofile and, unless --no-record, <prefix>.timings.json. The recorder's
// own spans cost about a tenth of a CPU-bound window, so take CPU attribution from a
// --no-record run. --boot-record starts the recorder before Play (allocation metrics).
// --check saves three screenshots (<prefix>.title/.loaded/.end.png) to verify navigation;
// they show game art, so keep them out of the repository.
//
// Save slots (user-provided test saves on load-screen page 1):
//   2  just before a scene transition; one click triggers it
//   3  full-screen idle animation; expression changes at clicks 1, 3, 6 and 8
//   4  shortly before a character enters on the next click
import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const slot = args[0],
  out = option('--out'),
  throttle = Number(option('--throttle', 6)),
  query = option('--query', ''),
  controller = option('--controller', 'http://127.0.0.1:9444'),
  origin = option('--origin', 'http://127.0.0.1:8001'),
  record = !args.includes('--no-record'),
  bootRecord = args.includes('--boot-record'),
  check = args.includes('--check');
if (!['2', '3', '4'].includes(slot) || out === undefined)
  throw new Error('Usage: aokana-scenario.mjs <2|3|4> --out <prefix> [options]');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function call(path, params = {}) {
  const response = await fetch(`${controller}/${path}?${new URLSearchParams(params)}`);
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${text}`);
  return text;
}
const evaluate = async (js) => JSON.parse(await call('eval', {js}));
const shot = (name) => (check ? call('shot', {file: `${out}.${name}.png`}) : undefined);
const toggleOptions = (open) =>
  `(() => { const t = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? '') === 'Toggle game options'); if ((t.getAttribute('aria-expanded') === 'true') !== ${open}) t.click(); return true; })()`;

/** Clicks at a fraction of the game canvas, so window size and sidebar layout do not matter. */
async function clickGame(fx, fy) {
  const [x, y, width, height] = await evaluate(
    `(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()`,
  );
  await call('click', {x: x + fx * width, y: y + fy * height});
}

await call('throttle', {rate: 1});
await call('nav', {url: `${origin}/buriko.html${query ? '?' + query : ''}`});
let play = null;
for (let i = 0; i < 300 && play === null; i++) {
  await delay(200);
  play = await evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Play' && !b.disabled); if (!b) return null; const r = b.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`,
  ).catch(() => null);
}
if (play === null) throw new Error('The Play button never became available');

// A cached page or service worker can serve an older bundle; measure only the current build.
const assets = fileURLToPath(new URL('../../site-profile/assets/', import.meta.url));
const expected = readdirSync(assets)
  .filter((name) => name.startsWith('source-'))
  .map((name) => readFileSync(assets + name, 'utf8').match(/profile-20[0-9T:.Z-]+/)?.[0])
  .find(Boolean);
const shown = await evaluate(
  `document.body.textContent.match(/Build: (profile-[0-9T:.Z-]+)/)?.[1] ?? null`,
);
if (shown !== expected) throw new Error(`Page build ${shown} is not the current build ${expected}`);

if (bootRecord) await call('recstart');
await call('click', {x: play[0], y: play[1]});
let skipping = false;
for (let i = 0; i < 50 && !skipping; i++) {
  await delay(200);
  skipping = await evaluate(
    `(() => { ${toggleOptions(true)}; const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Skip startup sequence'); if (!b) return false; b.click(); return true; })()`,
  );
}
await evaluate(toggleOptions(false));
// Skipping reaches the title after about 25 s.
await delay(30000);
// The skip button is a toggle; left on, it would fast-forward the loaded scene.
const stopped = await evaluate(
  `new Promise((resolve) => { ${toggleOptions(true)}; setTimeout(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Stop skipping'); if (b) b.click(); ${toggleOptions(false)}; resolve(b !== undefined); }, 300); })`,
);
if (!stopped) throw new Error('Startup skipping was not active at the title');
await delay(1000);
await shot('title');
await clickGame(0.475, 0.899); // Load
await delay(2500);
await clickGame({2: 0.3854, 3: 0.6125, 4: 0.8396}[slot], 0.2843);
await delay(1200);
await clickGame(0.4563, 0.5324); // confirm
await delay(8000);
await shot('loaded');

const advance = () => clickGame(0.5, 0.3583);
await call('throttle', {rate: throttle});
if (record && !bootRecord) await call('recstart');
await call('profstart');
const started = Date.now();
if (slot === '3') {
  await delay(10000); // idle animation alone
  for (let i = 0; i < 9; i++) {
    await advance();
    await delay(6000);
  }
} else {
  await delay(3000);
  await advance();
  await delay(20000);
}
await call('profstop', {file: `${out}.cpuprofile`});
if (record || bootRecord) await call('recstop', {file: `${out}.timings.json`});
await call('throttle', {rate: 1});
await shot('end');
console.log(JSON.stringify({slot, out, throttle, query, seconds: (Date.now() - started) / 1000}));
