import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// Differential harness for the Buriko BP interpreter's pure primary opcodes.
//
// A reference runtime and a candidate runtime (compiled `dist` directories, possibly the
// same one) execute identical generated cases. Each case seeds thread, bank, pool,
// indirect-handle and provenance state, then runs one instruction or a burst of pure
// instructions. State is digested after every instruction and compared.
//
//   node tools/differential-buriko-vm.mjs [options]
//     --reference DIR     reference runtime root (default dist)
//     --candidate DIR     candidate runtime root (default: the reference)
//     --abi LIST          comma list of 1.72, 1.665, 1.69 (default all)
//     --cases N           single-instruction cases per opcode and ABI (default 48)
//     --bursts N          multi-instruction cases per ABI (default 512)
//     --seed N            case generator seed (default 1)
//     --record FILE       write the candidate's case digests
//     --compare FILE      compare the candidate against recorded digests
//     --break GROUP       corrupt one opcode of GROUP in the candidate
//     --self-test         --break every group in turn; fail unless each is detected
//     --verbose           print every mismatching case, not only the first per opcode

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
};
const flag = (name) => args.includes(name);

const referenceRoot = resolve(option('--reference', 'dist'));
const candidateRoot = resolve(option('--candidate', referenceRoot));
const abiNames = option('--abi', '1.72,1.665,1.69').split(',');
const casesPerOpcode = Number(option('--cases', '48'));
const burstsPerAbi = Number(option('--bursts', '512'));
const seed = Number(option('--seed', '1')) >>> 0;
const recordPath = option('--record', null);
const comparePath = option('--compare', null);
const verbose = flag('--verbose');

const GROUPS = [
  'control',
  'integer',
  'memory',
  'locals',
  'fixed',
  'native-math',
  'write-watch',
  'legacy',
];

async function loadRuntime(root) {
  const load = (path) => import(pathToFileURL(resolve(root, path)).href);
  const [abi, state, memory, decode, provenance, diagnostics, ...groups] = await Promise.all([
    load('engines/buriko/bp/abi.js'),
    load('engines/buriko/bp/state.js'),
    load('engines/buriko/bp/memory.js'),
    load('engines/buriko/bp/decode.js'),
    load('core/indeterminate-memory.js'),
    load('engines/buriko/native/diagnostics.js'),
    load('engines/buriko/bp/opcodes/control.js'),
    load('engines/buriko/bp/opcodes/integer.js'),
    load('engines/buriko/bp/opcodes/memory.js'),
    load('engines/buriko/bp/opcodes/locals.js'),
    load('engines/buriko/bp/opcodes/fixed.js'),
    load('engines/buriko/bp/opcodes/native-math.js'),
    load('engines/buriko/native/write-watch-opcodes.js'),
    load('engines/buriko/bp/opcodes/legacy-169.js'),
    load('engines/buriko/bp/opcodes/legacy-1665.js'),
  ]);
  const [control, integer, memoryOps, locals, fixed, nativeMath, watch, legacy169, legacy1665] =
    groups;
  const abis = {
    1.72: abi.BURIKO_BP_ABI_172,
    1.665: abi.BURIKO_BP_ABI_1665,
    1.69: abi.BURIKO_BP_ABI_169,
  };
  // Mirrors createPrimaryOpcodes and the interpreter's write-watch overlay, pure groups only.
  const tables = {};
  for (const [name, value] of Object.entries(abis)) {
    const layers = [
      ['control', control.controlOpcodes],
      ['integer', integer.integerOpcodes],
      ['memory', memoryOps.memoryOpcodes],
      ['locals', locals.localOpcodes],
      ['fixed', fixed.fixedOpcodes],
      ['native-math', nativeMath.nativeMathOpcodes],
      ...(value.compatibility === '1.69'
        ? [['legacy', legacy169.createLegacy169CoreOpcodes()]]
        : []),
      ...(value.revision === '1.665' ? [['legacy', legacy1665.createLegacy1665CoreOpcodes()]] : []),
      ['write-watch', watch.writeWatchOpcodes],
    ];
    const table = new Map();
    for (const [group, handlers] of layers)
      for (const [key, handler] of Object.entries(handlers))
        table.set(Number(key), {group, handler});
    tables[name] = table;
  }
  return {root, abis, tables, state, memory, decode, provenance, diagnostics};
}

/** mulberry32: small, seedable, identical in every runner. */
function generator(value) {
  let state = value >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const below = (limit) => next() % limit;
  return {next, below, pick: (values) => values[below(values.length)]};
}

const FRAME_BYTES = 512;
const MODULE_BYTES = 512;
const GLOBAL_BYTES = 256;
const CODE_START = 256;
const STACK_CELLS = 16;

/** Operand bytes biased toward small immediates, varint continuations and sign bits. */
function operandByte(random) {
  switch (random.below(4)) {
    case 0:
      return random.below(8);
    case 1:
      return 0x80 | random.below(4);
    case 2:
      return random.pick([0x40, 0x7f, 0xff, 0xfc, 0x10, 0x20]);
    default:
      return random.below(256);
  }
}

/** A case is plain data; each runtime materializes it independently. */
function generateCase(random, abiName, abi, opcodes, burst) {
  const code = [];
  const count = burst ? 2 + random.below(15) : 1;
  for (let index = 0; index < count; index++) {
    code.push(burst ? random.pick(opcodes) : opcodes[0]);
    for (let operand = 0; operand < 8; operand++) code.push(operandByte(random));
  }
  const address = (kind) => {
    switch (kind) {
      case 'frame':
        return (abi.frameTag + random.below(FRAME_BYTES + 8)) >>> 0;
      case 'module':
        return (abi.moduleTag + random.below(MODULE_BYTES)) >>> 0;
      case 'heap':
        return (abi.heapTag + random.below(96)) >>> 0;
      case 'global':
        return 1 + random.below(GLOBAL_BYTES + 4);
      default:
        return 0;
    }
  };
  const word = () => {
    switch (random.below(10)) {
      case 0:
      case 1:
        return random.below(17);
      case 2:
        return -1 - random.below(16);
      case 3:
        return address('frame');
      case 4:
        return address('global');
      case 5:
        return address(random.pick(['heap', 'module']));
      case 6:
        return {pooled: random.below(24)};
      case 7:
        return abi.indirectHandles ? {indirect: random.below(24)} : random.next() & 0xffff;
      case 8:
        return random.pick([0x10000, -0x10000, 0x7fffffff, 0x80000000, 0x5a0000, 0xb40000]);
      default:
        return random.next();
    }
  };
  const bytes = (length) => Array.from({length}, () => random.below(256));
  const marks = [];
  for (let index = random.below(3); index > 0; index--)
    marks.push({
      bank: random.pick(['frame', 'global', 'heap']),
      offset: random.below(96),
      length: 1 + random.below(8),
      reason: `unwritten ${random.below(3)}`,
    });
  return {
    abi: abiName,
    opcode: opcodes[0],
    code,
    stack: Array.from({length: 8 + random.below(8)}, word),
    indeterminateCells: random.below(4) === 0 ? [random.below(8)] : [],
    frame: bytes(FRAME_BYTES),
    module: bytes(CODE_START),
    global: bytes(GLOBAL_BYTES),
    heap: bytes(128),
    frameCursor: 4 * (4 + random.below(FRAME_BYTES / 4 - 8)),
    callSites: random.below(2) === 0 ? [] : [CODE_START, CODE_START + 4],
    marks,
    watch:
      random.below(3) === 0
        ? {enabled: random.below(2) === 0, address: address('frame'), size: 1 + random.below(16)}
        : null,
  };
}

/** Bytes behind a resolved pointer in either the region (`view`) or legacy (`bytes`) shape. */
const pointerBytes = (pointer) =>
  typeof pointer.view === 'function' ? pointer.view() : pointer.bytes;
const heapBytes = (heap) => (heap.region ? heap.region.view() : heap.bytes);

function hashBytes(bytes) {
  let value = 2166136261,
    index = 0;
  if (bytes.byteOffset % 4 === 0) {
    const words = new Int32Array(bytes.buffer, bytes.byteOffset, bytes.length >>> 2);
    for (; index < words.length; index++) value = Math.imul(value ^ words[index], 16777619);
    index *= 4;
  }
  for (; index < bytes.length; index++) value = Math.imul(value ^ bytes[index], 16777619);
  return (value >>> 0).toString(16).padStart(8, '0');
}

/** Marked bytes as [offset, reason] runs, found by bisecting only marked ranges. */
function provenanceMarks(provenance, bytes) {
  const found = [];
  const visit = (start, length) => {
    if (length === 0 || !provenance.hasIndeterminateMemory(bytes, start, length)) return;
    if (length === 1) {
      try {
        provenance.requireDeterminateMemory(bytes, start, 1);
      } catch (error) {
        found.push(`${start}:${error.message}`);
      }
      return;
    }
    const half = length >>> 1;
    visit(start, half);
    visit(start + half, length - half);
  };
  visit(0, bytes.length);
  return found.join(',');
}

/**
 * Element-count loops whose iteration count comes from the operand stack. A zero element
 * size makes 0x64 iterate its full 32-bit count without faulting, as native does; such cases
 * stop before the instruction in both runners.
 */
const WORK_LIMIT = 1 << 16;
const stackWord = (thread, depth) =>
  thread.operandStack[
    (thread.stackIndex - depth + thread.operandStack.length) % thread.operandStack.length
  ];
const UNBOUNDED_WORK = {
  0x64: (thread) => stackWord(thread, 2),
  0x65: (thread) => stackWord(thread, 2),
};

class Materialized {
  constructor(runtime, testCase, corrupt) {
    const {state, memory, provenance, diagnostics} = runtime;
    const abi = runtime.abis[testCase.abi];
    this.runtime = runtime;
    this.table = runtime.tables[testCase.abi];
    this.corrupt = corrupt;
    this.notices = [];
    this.memory = new memory.BurikoBpMemory(Uint8Array.from(testCase.global), abi);
    const thread = (this.thread = new state.BurikoBpThread({
      id: 1,
      operandCapacity: STACK_CELLS,
      moduleCapacity: MODULE_BYTES,
      frameCapacity: FRAME_BYTES,
      heapEnabled: true,
      // Production threads share their memory's arena; runtimes before the arena ignore it.
      regions: this.memory.regions,
    }));
    thread.moduleMemory.set(testCase.module);
    thread.moduleMemory.set(testCase.code.slice(0, MODULE_BYTES - CODE_START), CODE_START);
    thread.frameMemory.set(testCase.frame);
    thread.heap.allocate(128);
    heapBytes(thread.heap).set(testCase.heap);
    this.pooled = [this.memory.allocatePooled(64), this.memory.allocatePooled(0x2000)];
    for (const address of this.pooled)
      pointerBytes(this.memory.resolve(thread, address)).fill(0x5a);
    this.indirect = abi.indirectHandles ? [this.memory.createBuffer(48).address] : [];
    if (abi.indirectHandles) {
      const created = this.memory.createString(new TextEncoder().encode('differential'));
      this.indirect.push(created.address);
    }
    const banks = {
      frame: thread.frameMemory,
      global: this.memory.globalMemory,
      heap: heapBytes(thread.heap),
    };
    for (const mark of testCase.marks)
      provenance.markIndeterminateMemory(banks[mark.bank], mark.offset, mark.length, mark.reason);
    testCase.stack.forEach((value, index) => {
      if (testCase.indeterminateCells.includes(index))
        state.pushIndeterminate32(thread, `indeterminate operand ${index}`);
      else if (typeof value === 'number') state.push32(thread, value);
      else if ('pooled' in value)
        state.push32(thread, this.pooled[value.pooled & 1] + value.pooled);
      else state.push32(thread, this.indirect[value.indirect & 1] + value.indirect);
    });
    thread.frameCursor = testCase.frameCursor;
    thread.callSites.push(...testCase.callSites);
    state.setPc(thread, CODE_START);
    this.diagnostics = new diagnostics.BurikoBpDiagnostics(
      (notice) => this.notices.push(`${notice.address}:${notice.size}`),
      abi,
    );
    if (testCase.watch) {
      this.diagnostics.registerWriteWatch(
        thread,
        testCase.watch.address,
        testCase.watch.size,
        Uint8Array.of(0x77),
      );
      this.diagnostics.writeWatchEnabled = testCase.watch.enabled;
    }
    this.context = {thread, memory: this.memory, diagnostics: this.diagnostics, actor: {}};
  }

  /** Runs one instruction. The status matches the planned wasm `run` statuses. */
  step() {
    const thread = this.thread;
    let opcode = -1;
    try {
      opcode = this.runtime.decode.fetchOpcode(thread);
      const entry = this.table.get(opcode);
      if (!entry) return {status: 'yield-host', opcode};
      const bound = UNBOUNDED_WORK[opcode];
      if (bound && entry.group === 'memory' && bound(thread) > WORK_LIMIT)
        return {status: 'unbounded', opcode};
      const result = entry.handler(this.context);
      if (result instanceof Promise) return {status: 'promise', opcode};
      if (this.corrupt?.opcode === opcode) thread.pc = (thread.pc ^ 1) >>> 0;
      return {status: result === 0 ? 'ok' : `result ${result}`, opcode};
    } catch (error) {
      return {status: 'fault', opcode, fault: `${error?.name}: ${error?.message}`};
    }
  }

  digest(outcome) {
    const {thread, memory, runtime} = this;
    const {provenance, state} = runtime;
    const index = thread.stackIndex;
    const tags = [];
    // popDeferred32 moves only the index, so each cell's provenance is read without loss.
    for (let cell = 0; cell < thread.operandStack.length; cell++) {
      thread.stackIndex = (cell + 1) % thread.operandStack.length;
      const {reason} = state.popDeferred32(thread);
      if (reason !== undefined) tags.push(`${cell}:${reason}`);
    }
    thread.stackIndex = index;
    const regions = [
      ['module', thread.moduleMemory],
      ['frame', thread.frameMemory],
      ['global', memory.globalMemory],
      ['heap', heapBytes(thread.heap)],
      ...this.pooled.map((address, slot) => [
        `pool${slot}`,
        pointerBytes(memory.resolve(thread, address)),
      ]),
      ...this.indirect.map((address, slot) => {
        const pointer = memory.resolve(thread, address);
        return [`indirect${slot}`, pointer ? pointerBytes(pointer) : new Uint8Array()];
      }),
    ];
    return [
      outcome.status,
      outcome.fault ?? '',
      `pc=${thread.pc} start=${thread.instructionStart} sp=${index} fc=${thread.frameCursor}`,
      `calls=${thread.callSites.join('/')}`,
      `stack=${Array.from(thread.operandStack).join('/')}`,
      `tags=${tags.join(',')}`,
      `watch=${this.diagnostics.writeWatchEnabled} ${this.notices.join(',')}`,
      ...regions.map(
        ([name, bytes]) =>
          `${name}=${bytes.length}:${hashBytes(bytes)}:${provenanceMarks(provenance, bytes)}`,
      ),
    ].join('\n');
  }

  /** Digests after every instruction until a non-`ok` status or the burst ends. */
  run(steps) {
    const digests = [];
    for (let index = 0; index < steps; index++) {
      const outcome = this.step();
      digests.push(this.digest(outcome));
      if (outcome.status !== 'ok') break;
    }
    return digests;
  }
}

function* cases(reference) {
  const random = generator(seed);
  for (const abiName of abiNames) {
    const abi = reference.abis[abiName];
    if (!abi) throw new Error(`Unknown ABI ${abiName}`);
    const opcodes = [...reference.tables[abiName].keys()].sort((a, b) => a - b);
    for (const opcode of opcodes)
      for (let index = 0; index < casesPerOpcode; index++)
        yield {
          id: `${abiName}/${opcode.toString(16).padStart(2, '0')}/${index}`,
          testCase: generateCase(random, abiName, abi, [opcode], false),
          steps: 1,
        };
    for (let index = 0; index < burstsPerAbi; index++) {
      const testCase = generateCase(random, abiName, abi, opcodes, true);
      yield {id: `${abiName}/burst/${index}`, testCase, steps: 16};
    }
  }
}

function firstDifference(left, right) {
  for (let step = 0; step < Math.max(left.length, right.length); step++) {
    if (left[step] === right[step]) continue;
    const a = (left[step] ?? '<missing>').split('\n'),
      b = (right[step] ?? '<missing>').split('\n');
    const line = a.findIndex((value, index) => value !== b[index]);
    return {step, reference: a[line] ?? a.join(' | '), candidate: b[line] ?? b.join(' | ')};
  }
  return null;
}

/** Compares reference and candidate (or recorded digests); returns mismatching case ids. */
async function differential(reference, candidate, corrupt, recorded) {
  const mismatches = [];
  const reported = new Set();
  const record = {};
  let total = 0;
  for (const {id, testCase, steps} of cases(reference)) {
    total++;
    const actual = new Materialized(candidate, testCase, corrupt).run(steps);
    const hash = hashBytes(new TextEncoder().encode(actual.join('\n\n')));
    if (recordPath) record[id] = hash;
    let difference = null;
    if (recorded) {
      if (recorded[id] !== hash)
        difference = {step: -1, reference: recorded[id] ?? '<missing>', candidate: hash};
    } else {
      const expected = new Materialized(reference, testCase, null).run(steps);
      difference = firstDifference(expected, actual);
    }
    if (difference) {
      mismatches.push(id);
      const key = id.split('/').slice(0, 2).join('/');
      if (!corrupt && (verbose || !reported.has(key))) {
        reported.add(key);
        console.log(`mismatch ${id} at instruction ${difference.step}`);
        console.log(`  reference: ${difference.reference}`);
        console.log(`  candidate: ${difference.candidate}`);
      }
    }
  }
  if (recordPath) await writeFile(recordPath, JSON.stringify({seed, abiNames, record}, null, 1));
  return {total, mismatches};
}

/** The lowest opcode a group defines under the selected ABIs, as [opcode, entry]. */
function findGroupOpcode(group) {
  for (const abiName of abiNames) {
    const found = [...candidate.tables[abiName]]
      .sort(([a], [b]) => a - b)
      .find(([, entry]) => entry.group === group);
    if (found) return found;
  }
  return null;
}

const reference = await loadRuntime(referenceRoot);
const candidate = candidateRoot === referenceRoot ? reference : await loadRuntime(candidateRoot);

if (flag('--self-test')) {
  let failed = false;
  for (const group of GROUPS) {
    const target = findGroupOpcode(group);
    if (!target) {
      console.log(`${group}: no opcode under ABIs ${abiNames.join(', ')}`);
      failed = true;
      continue;
    }
    const {mismatches} = await differential(reference, candidate, {opcode: target[0]}, null);
    const detected = mismatches.length > 0;
    failed ||= !detected;
    console.log(
      `${group}: corrupting 0x${target[0].toString(16)} ${detected ? `detected in ${mismatches.length} cases` : 'NOT detected'}`,
    );
  }
  process.exit(failed ? 1 : 0);
}

const breakGroup = option('--break', null);
let corrupt = null;
if (breakGroup) {
  const target = findGroupOpcode(breakGroup);
  if (!target) throw new Error(`No ${breakGroup} opcode under ABIs ${abiNames.join(', ')}`);
  corrupt = {opcode: target[0]};
}
const recorded = comparePath ? JSON.parse(await readFile(comparePath, 'utf8')).record : null;
const {total, mismatches} = await differential(reference, candidate, corrupt, recorded);
console.log(
  JSON.stringify({
    reference: reference.root,
    candidate: comparePath ?? candidate.root,
    seed,
    cases: total,
    mismatches: mismatches.length,
  }),
);
process.exit(mismatches.length === 0 ? 0 : 1);
