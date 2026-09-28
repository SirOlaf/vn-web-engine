// Summarizes captures from tools/profile-harness/aokana-scenario.mjs.
//
//   node tools/profile-harness/summarize.mjs <prefix>.cpuprofile [options]
//     --top <n>                 self and inclusive tables (default 30)
//     --functions a,b:line,...  inclusive/self ms of these functions (name, or name:line)
//     --children <fn>           inclusive ms of each direct callee of <fn>
//     --callers <regex>         heaviest caller chains of frames matching "<name> <url>"
//   node tools/profile-harness/summarize.mjs <prefix>.timings.json [...more]
//     VM instruction mix, frames, long tasks and resident-bitmap metrics per file.
//
// Bundle lines name the profile build in site-profile/assets; map them to sources through the
// preceding `//#region src/...` comment. Line numbers change with every build, so compare
// captures by function name.
import {readFileSync} from 'node:fs';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const files = args.filter(
  (arg, index) => !arg.startsWith('--') && !args[index - 1]?.startsWith('--'),
);

function summarizeTimings(file) {
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const aggregates = new Map(json.aggregates.map((entry) => [entry.name, entry]));
  const total = (name) => aggregates.get(name)?.total ?? 0;
  const accelerated = total('buriko.vm.accelerated-instructions'),
    executed = total('buriko.vm.executor-instructions'),
    runs = total('buriko.vm.accelerated-runs'),
    slices = total('buriko.vm.sync-slice');
  console.log(`== ${file}  ${(json.durationMs / 1000).toFixed(1)} s, build ${json.buildId}`);
  console.log(
    `instructions ${((accelerated + executed) / 1e6).toFixed(1)}M, wasm share ${(accelerated / (accelerated + executed) || 0).toFixed(3)}, per run ${(accelerated / runs || 0).toFixed(1)}, slices ${slices.toFixed(0)} ms (${((slices * 1e6) / (accelerated + executed) || 0).toFixed(0)} ns/instruction)`,
  );
  for (const name of [
    'buriko.display.present',
    'buriko.frame',
    'buriko.native.sync',
    'browser.long-task',
  ]) {
    const entry = aggregates.get(name);
    if (entry)
      console.log(`${name}: ${entry.count} × total ${entry.total.toFixed(0)} ms, max ${entry.max}`);
  }
  const resident = aggregates.get('buriko.bitmap.wasm-resident'),
    live = aggregates.get('buriko.bitmap.resident-live-bytes');
  if (resident)
    console.log(
      `kernel calls in place ${resident.total}/${resident.count}, resident peak ${((live?.max ?? 0) / 2 ** 20).toFixed(1)} MiB`,
    );
  for (const kind of ['executor-opcode', 'handback-opcode']) {
    const rows = json.aggregates
      .filter((entry) => entry.name.startsWith(`buriko.vm.${kind}.`))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);
    if (rows.length)
      console.log(
        `${kind}: ${rows.map((row) => `${row.name.split('.').pop()}=${row.total}`).join(' ')}`,
      );
  }
}

function summarizeProfile(file) {
  const profile = JSON.parse(readFileSync(file, 'utf8'));
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parents.set(child, node.id);
  const name = (node) => node.callFrame.functionName || '(anonymous)';
  const label = (node) =>
    `${name(node)} ${node.callFrame.url.split('/').pop()}:${node.callFrame.lineNumber + 1}`;
  const matches = (node, spec) => {
    const [fn, line] = spec.split(':');
    return name(node) === fn && (line === undefined || node.callFrame.lineNumber + 1 === +line);
  };
  const samples = profile.samples.map((id, index) => ({
    node: nodes.get(id),
    ms: (profile.timeDeltas[index + 1] ?? 0) / 1000,
  }));
  const stack = (node) => {
    const chain = [];
    for (let id = node.id; id !== undefined; id = parents.get(id)) chain.push(nodes.get(id));
    return chain;
  };
  const totalMs = samples.reduce((sum, sample) => sum + sample.ms, 0);
  console.log(`== ${file}  ${totalMs.toFixed(0)} ms sampled`);
  const print = (map, count) =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .forEach(([key, ms]) => console.log(ms.toFixed(0).padStart(8), key));

  const functions = option('--functions'),
    children = option('--children'),
    callers = option('--callers');
  if (functions !== undefined) {
    const specs = functions.split(',');
    const inclusive = new Map(specs.map((spec) => [spec, 0])),
      self = new Map(specs.map((spec) => [spec, 0]));
    for (const {node, ms} of samples) {
      for (const spec of specs) if (matches(node, spec)) self.set(spec, self.get(spec) + ms);
      const seen = new Set();
      for (const frame of stack(node))
        for (const spec of specs)
          if (!seen.has(spec) && matches(frame, spec)) {
            seen.add(spec);
            inclusive.set(spec, inclusive.get(spec) + ms);
          }
    }
    console.log('inclusive     self  function');
    for (const spec of specs)
      console.log(
        `${inclusive.get(spec).toFixed(0).padStart(9)} ${self.get(spec).toFixed(0).padStart(8)}  ${spec}`,
      );
  } else if (children !== undefined) {
    const callees = new Map();
    for (const {node, ms} of samples) {
      const chain = stack(node);
      const index = chain.findIndex((frame) => matches(frame, children));
      if (index < 0) continue;
      const key = index === 0 ? '(self)' : label(chain[index - 1]);
      callees.set(key, (callees.get(key) ?? 0) + ms);
    }
    print(callees, 30);
  } else if (callers !== undefined) {
    const pattern = new RegExp(callers),
      chains = new Map();
    for (const {node, ms} of samples) {
      if (!pattern.test(`${name(node)} ${node.callFrame.url}`)) continue;
      const key = stack(node)
        .slice(1, 7)
        .map((frame) => `${name(frame)}:${frame.callFrame.lineNumber + 1}`)
        .join(' < ');
      chains.set(key, (chains.get(key) ?? 0) + ms);
    }
    print(chains, 15);
  } else {
    const top = Number(option('--top', 30)),
      self = new Map(),
      inclusive = new Map();
    for (const {node, ms} of samples) {
      self.set(label(node), (self.get(label(node)) ?? 0) + ms);
      for (const key of new Set(stack(node).map(label)))
        inclusive.set(key, (inclusive.get(key) ?? 0) + ms);
    }
    console.log('## self');
    print(self, top);
    console.log('## inclusive');
    print(inclusive, top);
  }
}

if (files.length === 0) throw new Error('Pass .cpuprofile or .timings.json files');
for (const file of files)
  if (file.endsWith('.cpuprofile')) summarizeProfile(file);
  else summarizeTimings(file);
