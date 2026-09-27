import {resolve} from 'node:path';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

const options = parseSyntheticBrowserOptions(process.argv.slice(2));

async function pageMain(_fixture, options) {
  const {BurikoBpScheduler} = await import('/runtime/engines/buriko/bp/scheduler.js');
  const {BurikoBpThread} = await import('/runtime/engines/buriko/bp/state.js');
  const {runCooperativeTask} = await import('/runtime/core/cooperative-task.js');
  const {yieldToHost} = await import('/runtime/core/host-task-budget.js');
  const {setRuntimeProfile} = await import('/runtime/platform/runtime-profile.js');
  const thread = (id) =>
    new BurikoBpThread({
      id,
      operandCapacity: 16,
      moduleCapacity: 0,
      frameCapacity: 0,
      heapEnabled: false,
    });
  const chunks = options.smoke ? 12 : 96;
  function* compute() {
    let hash = 2166136261;
    for (let chunk = 0; chunk < chunks; chunk++) {
      for (let index = 0; index < 262144; index++) hash = Math.imul(hash ^ index ^ chunk, 16777619);
      yield;
    }
    return hash >>> 0;
  }
  const round = (value) => Math.round(value * 100) / 100;
  const records = [];
  let expectedHash;
  // Alternate profiles to reduce warmup/thermal ordering bias. This measures
  // presentation opportunities, not FPS: no renderer or game data is involved.
  for (let iteration = 0; iteration < options.iterations + 3; iteration++) {
    for (const profile of iteration % 2
      ? ['browser-optimized', 'native']
      : ['native', 'browser-optimized']) {
      setRuntimeProfile(profile);
      let done = false,
        hash,
        completedMs,
        backgroundError;
      const visited = [];
      const scheduler = new BurikoBpScheduler(thread(0), (state) => {
        visited.push(state.id);
        return visited.length % 24 === 0 ? 1 : 0;
      });
      for (let id = 1; id <= 32; id++) scheduler.append(thread(id));
      scheduler.attachDataCodecWorkers({hasPendingWork: () => !done});
      await yieldToHost();
      const start = performance.now();
      const background = new Promise((resolve) => {
        setTimeout(() => {
          runCooperativeTask(compute()).then(
            (value) => {
              hash = value;
              completedMs = performance.now() - start;
              done = true;
              resolve();
            },
            (error) => {
              backgroundError = error;
              done = true;
              resolve();
            },
          );
        }, 0);
      });
      const passMs = [];
      do {
        visited.length = 0;
        const passStart = performance.now();
        await scheduler.run();
        passMs.push(performance.now() - passStart);
        if (
          visited.length !== 32 * 24 ||
          visited.some((id, index) => id !== 1 + Math.floor(index / 24))
        )
          throw new Error('Profile changed child or instruction traversal');
        // A real frame can present here, after the complete native traversal.
        await yieldToHost();
      } while (!done);
      await background;
      scheduler.removeAllChildren();
      if (backgroundError) throw backgroundError;
      if (expectedHash === undefined) expectedHash = hash;
      if (hash !== expectedHash) throw new Error('Background computation changed between profiles');
      records.push({
        profile,
        iteration,
        warm: iteration >= 3,
        hash,
        passes: passMs.length,
        firstPassMs: round(passMs[0]),
        longestPassMs: round(Math.max(...passMs)),
        completedMs: round(completedMs),
        passMs: passMs.map(round),
      });
    }
  }
  setRuntimeProfile('native');
  const results = ['native', 'browser-optimized'].map((profile) => {
    const samples = records.filter((record) => record.profile === profile && record.warm);
    const median = (key) =>
      samples.map((record) => record[key]).sort((a, b) => a - b)[samples.length >> 1];
    return {
      profile,
      medianFirstPassMs: median('firstPassMs'),
      medianLongestPassMs: median('longestPassMs'),
      medianCompletedMs: median('completedMs'),
      medianPasses: median('passes'),
    };
  });
  return {
    available: true,
    synthetic: true,
    chunks,
    children: 32,
    instructionsPerChild: 24,
    expectedHash,
    results,
    records,
  };
}

const result = await runSyntheticBrowserProbe({
  options,
  pageMain,
  runtimeRoot: resolve('dist'),
  name: 'vn-buriko-scheduling',
});
console.log(JSON.stringify({synthetic: true, results: result.results}, null, 2));
