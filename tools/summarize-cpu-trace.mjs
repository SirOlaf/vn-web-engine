import {readFileSync} from 'node:fs';

// Summarizes the sampled CPU profile inside a Chromium Performance-panel trace export.
// Locations name the served bundle (for profile builds, site-profile/assets/<chunk>:<line>).
const usage = `Usage: node tools/summarize-cpu-trace.mjs <trace.json> [options]
  --thread <name>     Thread to summarize (default CrRendererMain)
  --top <n>           Rows per table (default 40)
  --lines <f1,f2>     Self time per source line for these function names
  --callers <f1,f2>   Heaviest caller chains for these function names
  --timeline <ms>     Top self-time functions per bucket of this width`;

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  console.log(usage);
  process.exit(args.length === 0 ? 1 : 0);
}
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const list = (name) => (option(name, '') || '').split(',').filter(Boolean);
const threadName = option('--thread', 'CrRendererMain'),
  top = Number(option('--top', 40)),
  lineFunctions = new Set(list('--lines')),
  callerFunctions = list('--callers'),
  bucketMs = Number(option('--timeline', 0));

const raw = JSON.parse(readFileSync(args[0], 'utf8'));
const events = Array.isArray(raw) ? raw : raw.traceEvents;
const threads = new Map();
for (const event of events)
  if (event.ph === 'M' && event.name === 'thread_name')
    threads.set(`${event.pid}:${event.tid}`, event.args.name);

// Profile/ProfileChunk events share an id per profiled thread.
const profiles = new Map();
for (const event of events) {
  const key = `${event.pid}:${event.id}`;
  if (event.name === 'Profile')
    profiles.set(key, {
      thread: threads.get(`${event.pid}:${event.tid}`),
      nodes: new Map(),
      samples: [],
      deltas: [],
      lines: [],
    });
  else if (event.name === 'ProfileChunk' && profiles.has(key)) {
    const profile = profiles.get(key),
      data = event.args.data;
    for (const node of data.cpuProfile?.nodes ?? []) profile.nodes.set(node.id, node);
    const samples = data.cpuProfile?.samples ?? [];
    profile.samples.push(...samples);
    profile.lines.push(...(data.lines ?? samples.map(() => 0)));
    profile.deltas.push(...(data.timeDeltas ?? []));
  }
}
const profile = [...profiles.values()]
  .filter((candidate) => candidate.thread === threadName)
  .sort((a, b) => b.samples.length - a.samples.length)[0];
if (profile === undefined) throw new Error(`No sampled profile for thread ${threadName}`);

const label = (node) => {
  const frame = node.callFrame,
    name = frame.functionName || '(anonymous)';
  return frame.url ? `${name} ${frame.url.split('/').pop()}:${frame.lineNumber + 1}` : name;
};
const self = new Map(),
  total = new Map(),
  lines = new Map(),
  callers = new Map(callerFunctions.map((name) => [name, new Map()])),
  buckets = [];
const add = (map, key, value) => map.set(key, (map.get(key) ?? 0) + value);
let elapsed = 0;
for (let index = 0; index < profile.samples.length; index++) {
  // timeDeltas[i] precedes sample i, so sample i lasts until the next delta.
  const duration = (profile.deltas[index + 1] ?? 0) / 1000;
  elapsed += duration;
  const chain = [];
  for (let id = profile.samples[index]; id !== undefined;) {
    const node = profile.nodes.get(id);
    if (node === undefined) break;
    chain.push(node);
    id = node.parent;
  }
  if (chain.length === 0) continue;
  const leaf = label(chain[0]);
  add(self, leaf, duration);
  for (const key of new Set(chain.map(label))) add(total, key, duration);
  if (lineFunctions.has(chain[0].callFrame.functionName)) {
    const frame = chain[0].callFrame;
    add(
      lines,
      `${frame.functionName} ${frame.url.split('/').pop()}:${profile.lines[index]}`,
      duration,
    );
  }
  for (const [name, stacks] of callers) {
    const at = chain.findIndex((node) => node.callFrame.functionName === name);
    if (at !== -1)
      add(
        stacks,
        chain
          .slice(at, at + 7)
          .map(label)
          .join(' < '),
        duration,
      );
  }
  if (bucketMs > 0) add((buckets[Math.floor(elapsed / bucketMs)] ??= new Map()), leaf, duration);
}

const table = (title, map, rows = top) => {
  if (map.size === 0) return;
  console.log(`\n## ${title}`);
  for (const [key, value] of [...map].sort((a, b) => b[1] - a[1]).slice(0, rows))
    console.log(`${value.toFixed(1).padStart(9)} ms  ${key}`);
};
console.log(`${threadName}: ${profile.samples.length} samples, ${elapsed.toFixed(0)} ms`);
table('Self time', self);
table('Inclusive time', total);
table('Self time by line', lines);
for (const [name, stacks] of callers) table(`Callers of ${name}`, stacks, 12);
if (bucketMs > 0) {
  console.log(`\n## Timeline (${bucketMs} ms buckets, top self time)`);
  buckets.forEach((bucket, index) =>
    console.log(
      `${String(index * bucketMs).padStart(7)} ms  ` +
        [...bucket]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([key, value]) => `${key.split(' ')[0]}=${value.toFixed(0)}`)
          .join('  '),
    ),
  );
}
