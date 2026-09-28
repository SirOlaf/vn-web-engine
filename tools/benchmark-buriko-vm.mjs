import {resolve} from 'node:path';
import {
  parseSyntheticBrowserOptions,
  runSyntheticBrowserProbe,
} from './lib/synthetic-browser-probe.mjs';

// Generated BP bytecode and numeric state only. Production opcode handlers run
// through the interpreter; no game modules, renderer, or presentation sink exist.
const args = process.argv.slice(2);
let runtimeRoot = resolve('dist');
let profile = 'browser-optimized';
const profileIndex = args.indexOf('--profile');
if (profileIndex !== -1) {
  profile = args[profileIndex + 1];
  if (profile !== 'native' && profile !== 'browser-optimized')
    throw new Error('--profile requires native or browser-optimized');
  args.splice(profileIndex, 2);
}
const rootIndex = args.indexOf('--runtime-root');
if (rootIndex !== -1) {
  if (!args[rootIndex + 1] || args[rootIndex + 1].startsWith('--'))
    throw new Error('--runtime-root requires a compiled runtime directory');
  runtimeRoot = resolve(args[rootIndex + 1]);
  args.splice(rootIndex, 2);
}
const options = parseSyntheticBrowserOptions(args);

async function pageMain({profile}, options) {
  const {BurikoBpInterpreter} = await import('/runtime/engines/buriko/bp/interpreter.js');
  const {BurikoBpThread} = await import('/runtime/engines/buriko/bp/state.js');
  const {BurikoBpScheduler} = await import('/runtime/engines/buriko/bp/scheduler.js');
  const {setRuntimeProfile} = await import('/runtime/platform/runtime-profile.js');
  const {
    startRuntimePerformanceRecording,
    stopRuntimePerformanceRecording,
    getRuntimePerformanceSnapshot,
  } = await import('/runtime/platform/runtime-performance.js');
  const {BurikoBpMemory} = await import('/runtime/engines/buriko/bp/memory.js');
  const {attachModule} = await import('/runtime/engines/buriko/bp/modules.js');
  const {BurikoBpModuleExtensions} =
    await import('/runtime/engines/buriko/bp/module-extensions.js');
  const {BurikoBpDiagnostics} = await import('/runtime/engines/buriko/native/diagnostics.js');
  const {BurikoNativeBank} = await import('/runtime/engines/buriko/native/registry.js');
  const {BURIKO_NATIVE_SLOT_ADDRESSES, BURIKO_PRIMARY_SLOT_ADDRESSES} =
    await import('/runtime/engines/buriko/native/inventory.js');
  const {controlOpcodes} = await import('/runtime/engines/buriko/bp/opcodes/control.js');
  const {integerOpcodes} = await import('/runtime/engines/buriko/bp/opcodes/integer.js');
  const {memoryOpcodes} = await import('/runtime/engines/buriko/bp/opcodes/memory.js');
  const {BurikoCrtRandom} = await import('/runtime/engines/buriko/native/system-timing.js');
  const {createGroup80Timing} = await import('/runtime/engines/buriko/native/group-80-timing.js');
  const unexpected = () => {
    throw new Error('Unselected synthetic VM service executed');
  };
  const random = new BurikoCrtRandom();
  // Only the actual CRT random handler is selected; other native slots must still
  // satisfy complete-bank validation and fail explicitly if accidentally called.
  const randomDefinition = createGroup80Timing(random, null, null, null).find(
    (definition) => definition.secondary === 1,
  );
  const definitions = Object.entries(BURIKO_NATIVE_SLOT_ADDRESSES).flatMap(([primary, slots]) =>
    Object.entries(slots).map(([secondary, nativeAddress]) =>
      Number(primary) === 0x80 && Number(secondary) === 1
        ? randomDefinition
        : {
            primary: Number(primary),
            secondary: Number(secondary),
            nativeAddress,
            name: 'Unselected synthetic native slot',
            execute: unexpected,
          },
    ),
  );
  const primary = Object.fromEntries(
    Object.keys(BURIKO_PRIMARY_SLOT_ADDRESSES)
      .map(Number)
      .filter((opcode) => !BURIKO_NATIVE_SLOT_ADDRESSES[opcode] && opcode !== 0xff)
      .map((opcode) => [opcode, unexpected]),
  );
  const memory = new BurikoBpMemory(new Uint8Array(256));
  const diagnostics = new BurikoBpDiagnostics(unexpected);
  const actor = {};
  const interpreter = new BurikoBpInterpreter(
    {...primary, ...controlOpcodes, ...integerOpcodes, ...memoryOpcodes},
    new BurikoNativeBank(definitions),
    new BurikoBpModuleExtensions({readModule: unexpected}),
    (thread) => ({thread, memory, diagnostics, actor}),
  );
  const varint = (value) => {
    const bytes = [];
    let remaining = BigInt(value);
    for (;;) {
      const byte = Number(remaining & 127n);
      remaining >>= 7n;
      if ((remaining === 0n && (byte & 64) === 0) || (remaining === -1n && (byte & 64) !== 0)) {
        bytes.push(byte);
        return bytes;
      }
      bytes.push(byte | 128);
    }
  };
  const branchToStart = (bytes, conditional) => {
    const displacement = -bytes.length;
    return [
      ...bytes,
      ...(conditional ? [0x15, 8] : [0x13]),
      displacement & 255,
      (displacement >> 8) & 255,
    ];
  };
  const programs = [
    {
      name: 'arithmetic-fixed-width-branch',
      stepsPerCycle: 8,
      bytes: branchToStart([0, 17, 0, 9, 0x22, 0, 7, 0x20, 0, 5, 0x35], true),
    },
    ...[7, -7].map((operand) => ({
      name: operand < 0 ? 'arithmetic-negative-branch' : 'arithmetic-positive-branch',
      stepsPerCycle: 6,
      bytes: branchToStart([0, 17, 0, 9, 0x22, 0x2c, ...varint(operand), 0x36, 5, 0], true),
    })),
    {
      name: 'typed-negative-local-branch',
      stepsPerCycle: 6,
      bytes: branchToStart(
        [
          0x0e,
          0,
          0,
          ...varint(-17 * 4 + 2),
          0x19,
          0,
          0x80,
          0x2c,
          23,
          0x2d,
          ...varint(-7),
          0x36,
          2,
          0,
        ],
        true,
      ),
    },
    {
      name: 'native-random-branch',
      stepsPerCycle: 5,
      bytes: branchToStart([0x80, 1, 0, 63, 0x25, 0x73], false),
    },
  ];
  // Runtimes with the WebAssembly core also run the scheduled workloads through it.
  const wasm = memory.wasm ?? null;
  wasm?.configure(interpreter.directOpcodes, interpreter.batchableOpcodes, diagnostics);
  const workloads = [
    ...programs.map((program) => ({...program, scheduled: false})),
    ...programs
      .filter(
        (program) =>
          program.name === 'arithmetic-positive-branch' ||
          program.name === 'typed-negative-local-branch' ||
          program.name === 'arithmetic-fixed-width-branch' ||
          program.name === 'native-random-branch',
      )
      .map((program) => ({...program, scheduled: true})),
    ...(wasm === null
      ? []
      : programs.map((program) => ({...program, scheduled: true, accelerated: true}))),
  ];
  setRuntimeProfile(profile);
  const cycles = options.smoke ? 1000 : 100000;
  const hash = (thread) => {
    let value = 2166136261;
    const stack = thread.operandStack;
    const stackBytes = new Uint8Array(stack.buffer, stack.byteOffset, stack.byteLength);
    for (const byte of [...stackBytes, ...thread.frameMemory])
      value = Math.imul(value ^ byte, 16777619);
    return (value >>> 0).toString(16).padStart(8, '0');
  };
  const round = (value) => Math.round(value * 100) / 100;
  const cases = [];
  for (const program of workloads) {
    const thread = new BurikoBpThread({
      id: 1,
      operandCapacity: 16,
      moduleCapacity: 256,
      frameCapacity: 64,
      heapEnabled: false,
      regions: memory.regions,
    });
    const bytes = new Uint8Array(16 + program.bytes.length);
    const header = new DataView(bytes.buffer);
    header.setUint32(0, 16, true);
    header.setUint32(4, program.bytes.length, true);
    bytes.set(program.bytes, 16);
    attachModule(thread, 'synthetic numeric VM probe', bytes);
    const instructions = cycles * program.stepsPerCycle;
    const samples = [];
    const schedulerSamples = [];
    let executed = 0;
    const scheduler = program.scheduled
      ? new BurikoBpScheduler(
          new BurikoBpThread({
            id: 0,
            operandCapacity: 0,
            moduleCapacity: 0,
            frameCapacity: 0,
            heapEnabled: false,
          }),
        )
      : null;
    scheduler?.bindInstructionExecutor((current) => {
      const result = interpreter.step(current);
      if (result !== 0) throw new Error('Synthetic instruction suspended');
      // The benchmark ends after an exact count without changing the opcode
      // loop, native burst limit, host budget, or scheduler traversal.
      return ++executed === instructions ? 1 : result;
    }, interpreter.batchableOpcodes);
    if (program.accelerated) {
      // Stops at the same exact instruction count as the executor above.
      scheduler.bindBurstAccelerator({
        opcodes: wasm.opcodes,
        result: 0,
        get batchable() {
          return wasm.batchable;
        },
        get blocked() {
          return wasm.blocked;
        },
        run(current, limit) {
          const count = wasm.run(current, Math.min(limit, instructions - executed));
          executed += count;
          this.result = count !== 0 && executed === instructions ? 1 : wasm.result;
          return count;
        },
      });
    }
    scheduler?.append(thread);
    let coldMs;
    let checksum;
    for (let pass = 0; pass < options.iterations + 3; pass++) {
      thread.pc = 0;
      thread.stackIndex = 0;
      thread.frameCursor = 16;
      thread.operandStack.fill(0);
      thread.frameMemory.fill(0);
      random.seed(1234);
      await new Promise((resolve) => setTimeout(resolve, 0));
      executed = 0;
      if (scheduler) startRuntimePerformanceRecording();
      const start = performance.now();
      if (scheduler) {
        if ((await scheduler.run()) !== 0 || executed !== instructions)
          throw new Error('Synthetic scheduler did not complete its fixed instruction count');
      } else {
        for (let instruction = 0; instruction < instructions; instruction++) {
          if (interpreter.step(thread) !== 0) throw new Error('Synthetic instruction suspended');
        }
      }
      const elapsed = performance.now() - start;
      if (scheduler) {
        stopRuntimePerformanceRecording();
        const snapshot = getRuntimePerformanceSnapshot();
        const slices = snapshot.aggregates.find(
          (aggregate) => aggregate.name === 'buriko.vm.sync-slice',
        );
        if (pass >= 3)
          schedulerSamples.push({
            elapsedMs: round(elapsed),
            instructions: executed,
            syncSliceTotalMs: slices.total,
            syncSliceMaxMs: slices.max,
            syncSlices: slices.count,
            budgetYields:
              snapshot.aggregates.find((aggregate) => aggregate.name === 'buriko.vm.budget-yields')
                ?.total ?? 0,
            retainedSlices: snapshot.events
              .filter((event) => event.name === 'buriko.vm.sync-slice')
              .map((event) => ({
                durationMs: event.durationMs,
                instructions: event.detail.instructions,
              })),
          });
      }
      if (thread.pc !== 0 || thread.stackIndex !== 0)
        throw new Error('Synthetic loop did not finish at its initial PC and stack depth');
      const current = hash(thread);
      if (checksum !== undefined && checksum !== current)
        throw new Error('Synthetic VM state changed between passes');
      checksum = current;
      if (pass === 0) coldMs = elapsed;
      if (pass >= 3) samples.push(elapsed);
    }
    samples.sort((a, b) => a - b);
    cases.push({
      name: (program.accelerated ? 'wasm-' : program.scheduled ? 'scheduled-' : '') + program.name,
      scheduled: program.scheduled,
      instructions,
      hash: checksum,
      coldMs: round(coldMs),
      medianMs: round(samples[samples.length >> 1]),
      maxMs: round(samples.at(-1)),
      samplesMs: samples.map(round),
      ...(program.scheduled ? {runtimeProfile: profile, diagnostics: true, schedulerSamples} : {}),
    });
  }
  return {available: true, synthetic: true, cases};
}

const result = await runSyntheticBrowserProbe({
  options,
  fixture: {profile},
  pageMain,
  runtimeRoot,
  name: 'vn-buriko-vm',
});
console.log(
  JSON.stringify(
    {synthetic: true, cases: result.cases.map(({schedulerSamples, ...summary}) => summary)},
    null,
    2,
  ),
);
