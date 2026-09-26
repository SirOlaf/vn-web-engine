/**
 * Bounded, nonvisual production boot probe for local BGI installations.
 * It never presents or inspects pixels and never logs dialogue/resource bytes.
 * Run after `npm run build:runtime`.
 * A verified product ID may be supplied as BURIKO_PROBE_PRODUCT_ID when a packed executable hides it.
 * BURIKO_PROBE_EXECUTABLE substitutes a root file at the selected executable's mounted path.
 */
import {open, readdir} from 'node:fs/promises';
import {basename, dirname, join, relative, resolve, sep} from 'node:path';
import {OverlayFileSystem, SourceFileSystem} from '../dist/platform/filesystem.js';
import {MemoryStore} from '../dist/platform/store.js';
import {BrowserX86CompatibilityCpuHost} from '../dist/platform/browser-x86-cpu.js';
import {sha256} from '../dist/core/sha256.js';
import {readPeVersionStrings} from '../dist/formats/pe/version-info.js';
import {burikoEngineVersion} from '../dist/engines/buriko/native/engine-version.js';
import {readBurikoBootProductIdentity} from '../dist/engines/buriko/native/boot-metadata-source.js';
import {burikoInstallationView} from '../dist/engines/buriko/installation-view.js';
import {createMountedVmFixture} from '../tests/aokana-production-vm-fixture.mjs';
import {BurikoProductionBootRunner} from '../dist/engines/buriko/native/production-boot-runner.js';

const defaultRoots = ['targetgame/aokana', 'targetgame/穢翼のユースティアno-patch'];
const legacyAokanaSha256 = 'f585e28f79923b8aa487d8690165e45ce3377c7e1b8381d3b75c659c7e933d7a';
const legacyAokanaIdentity = 'AoNoKanataNoFourRhythmUEDL';
const roots = process.argv.slice(2).length ? process.argv.slice(2) : defaultRoots;
const maxFrames = Number.parseInt(process.env.BURIKO_PROBE_FRAMES ?? '4', 10);
const maxOpcodes = Number.parseInt(process.env.BURIKO_PROBE_OPCODES ?? '20000', 10);
const timeoutMs = Number.parseInt(process.env.BURIKO_PROBE_TIMEOUT_MS ?? '15000', 10);
const frameMs = Number.parseInt(process.env.BURIKO_PROBE_FRAME_MS ?? '17', 10);

if (
  ![maxFrames, maxOpcodes, timeoutMs, frameMs].every(Number.isSafeInteger) ||
  maxFrames < 1 ||
  maxOpcodes < 1 ||
  timeoutMs < 1 ||
  frameMs < 1
) {
  throw new RangeError('Probe limits must be positive safe integers');
}

async function walk(directory, output = [], directories = []) {
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      directories.push(path);
      await walk(path, output, directories);
    } else if (entry.isFile()) output.push(path);
  }
  return output;
}

class HandleSource {
  constructor(path, size) {
    this.path = path;
    this.size = size;
  }
  async read(offset, length) {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > this.size
    )
      throw new RangeError('Probe file read is outside the mounted source');
    const bytes = new Uint8Array(length);
    let done = 0;
    const handle = await open(this.path, 'r');
    try {
      while (done < length) {
        const result = await handle.read(bytes, done, length - done, offset + done);
        if (!result.bytesRead) throw new Error('Unexpected EOF while reading a mounted game file');
        done += result.bytesRead;
      }
    } finally {
      await handle.close();
    }
    return bytes;
  }
}

function timeout(promise, ms, phase) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${phase} exceeded ${ms} ms probe limit`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function embeddedProductIdentity(bytes) {
  const text = new TextDecoder('latin1').decode(bytes);
  const identities = new Set(
    Array.from(
      text.matchAll(/Buriko General Interpreter for ([ -~]{1,255}) is executing\.\0/g),
      (match) => match[1],
    ).filter((value) => value && !value.includes('%')),
  );
  return identities.size === 1 ? [...identities][0] : null;
}

async function selectInterpreter(files, root) {
  const candidates = files.filter(
    (path) =>
      dirname(path) === root &&
      path.toLowerCase().endsWith('.exe') &&
      !/ForInstalling\.exe$/i.test(basename(path)),
  );
  candidates.sort(
    (left, right) =>
      Number(basename(right).toLowerCase() === 'bgi.exe') -
      Number(basename(left).toLowerCase() === 'bgi.exe'),
  );
  if (candidates.length === 0)
    throw new Error('No root executable was found; graph profile needs an executable path');
  const interpreters = [];
  for (const path of candidates) {
    const handle = await open(path, 'r');
    const {size} = await handle.stat();
    await handle.close();
    if (size > 512 * 1024 * 1024) continue;
    const bytes = await new HandleSource(path, size).read(0, size);
    let versions = [];
    try {
      versions = readPeVersionStrings(bytes);
    } catch {
      // Auxiliary executables may be protected or unrelated.
    }
    const isInterpreter =
      versions.some(
        ({values}) =>
          /BURIKO General Interpreter/i.test(values.FileDescription ?? '') ||
          values.InternalName?.toLowerCase() === 'ethornell',
      ) || embeddedProductIdentity(bytes) !== null;
    if (!isInterpreter) continue;
    interpreters.push(path);
    if (basename(path).toLowerCase() === 'bgi.exe') return path;
  }
  if (interpreters.length === 1) return interpreters[0];
  throw new Error(
    interpreters.length > 1
      ? `Multiple BGI interpreters were found: ${interpreters.map((path) => basename(path)).join(', ')}. Select an installation containing only the intended game interpreter.`
      : 'No identifiable BGI / Ethornell interpreter was found in the installation root.',
  );
}

async function probe(inputRoot) {
  const root = resolve(inputRoot);
  const directories = [];
  const files = await walk(root, [], directories);
  const selected = files;
  const executable = await selectInterpreter(selected, root);
  const executableOverride = process.env.BURIKO_PROBE_EXECUTABLE;
  const executableInput =
    executableOverride === undefined ? executable : join(root, executableOverride);
  if (executableInput !== undefined && dirname(executableInput) !== root)
    throw new Error('The executable override must name a file in the installation root');
  if (executableInput !== undefined && !files.includes(executableInput))
    throw new Error('The executable override is absent from the installation root');
  const sources = new SourceFileSystem((path) => path.toLowerCase());
  let executableSource;
  let bootArchiveSource;
  let fixture;
  let runner;
  let opcodeCount = 0;
  let frameCount = 0;
  const opcodeCounts = new Map();
  const moduleNames = [];
  const dialogs = [];
  let outcome = 'not-started';
  let error = null;
  let errorFrames = [];
  const instructionTail = [];
  const sourceEntries = [];
  const fileMetadataRecords = [];

  try {
    for (const path of selected) {
      const inputPath = path === executable ? executableInput : path;
      const handle = await open(inputPath, 'r');
      const {size, mtimeMs} = await handle.stat();
      await handle.close();
      const source = new HandleSource(inputPath, size);
      sourceEntries.push({path: '/' + relative(root, path).split(sep).join('/'), source});
      fileMetadataRecords.push({
        path: '/game/' + relative(root, path).split(sep).join('/'),
        kind: 'file',
        attributes: null,
        creationTime: null,
        accessTime: null,
        writeTime: (BigInt(Math.trunc(mtimeMs)) + 11644473600000n) * 10000n,
      });
      if (path === executable) executableSource = source;
      if (dirname(path) === root && basename(path).toLowerCase() === 'system.arc')
        bootArchiveSource = source;
    }
    const installationView = await burikoInstallationView(
      sourceEntries,
      '/' + relative(root, executable).split(sep).join('/'),
    );
    for (const entry of installationView.files) sources.attach(entry.path, entry.source);
    for (const path of directories)
      sources.attachDirectory('/' + relative(root, path).split(sep).join('/'));
    const mountedPaths = new Set(installationView.files.map((entry) => '/game' + entry.path));
    console.log(
      JSON.stringify({
        game: basename(root),
        phase: 'mounted-view',
        executable: basename(executable),
        kind: installationView.kind,
        mountedFiles: installationView.files.length,
        excludedFiles: installationView.excludedPaths.length,
      }),
    );
    if (executableSource.size > 512 * 1024 * 1024)
      throw new Error('Selected executable exceeds the installation inspector size limit');
    const executableBytes = await executableSource.read(0, executableSource.size);
    const executableHash = Array.from(await sha256(executableBytes), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    let productIdentity =
      process.env.BURIKO_PROBE_PRODUCT_ID ??
      (executableHash === legacyAokanaSha256
        ? legacyAokanaIdentity
        : embeddedProductIdentity(executableBytes));
    const versionText = readPeVersionStrings(executableBytes)[0]?.values.FileVersion ?? '';
    const engineVersion = burikoEngineVersion(
      /(?:^|\s)Version\s*:\s*([\d.]+)/i.exec(versionText)?.[1] ?? null,
      /Compatibility\s*:\s*([\d.]+)/i.exec(versionText)?.[1] ?? null,
    );
    if (productIdentity === null && bootArchiveSource !== undefined) {
      const inferred = await readBurikoBootProductIdentity(bootArchiveSource, engineVersion.bpAbi);
      if (inferred !== null) productIdentity = new TextDecoder('ascii').decode(inferred);
    }

    let now = 0;
    const headlessPerformance = {now: () => ++now};
    fixture = await createMountedVmFixture({
      boot: false,
      sourceFiles: new OverlayFileSystem(sources, new MemoryStore(), (path) => path.toLowerCase()),
      fileMetadataRecords: fileMetadataRecords.filter((record) => mountedPaths.has(record.path)),
      seedBootArchive: false,
      executablePathWide: `C:\\game\\${basename(executable)}`,
      productIdentity: productIdentity ?? '',
      engineVersion,
      commandLineTailWide: '',
      presentationMode: 'none',
      cpuHost: new BrowserX86CompatibilityCpuHost(headlessPerformance),
      onDialogShown(element) {
        const id = typeof element.id === 'string' && element.id ? element.id : element.tagName;
        dialogs.push(id);
        // Trigger the engine's native cancel path so modal promises settle in the headless graph.
        element.cancel?.();
        if (element.open) throw new Error(`Probe stopped at unresolved native dialog ${id}`);
      },
      sleep: async () => {},
      performanceNow: headlessPerformance.now,
    });
    // Supply a valid browser desktop-sized client profile for this headless host.
    fixture.graph.display.requestedWidth = 800;
    fixture.graph.display.requestedHeight = 600;

    runner = await timeout(
      BurikoProductionBootRunner.start(fixture.core),
      timeoutMs,
      'runner startup',
    );
    const names = await timeout(runner.reset.run(), timeoutMs, 'ordered boot reset');
    if (names === null) throw new Error('Native boot reset did not select a boot module');
    const archiveText = fixture.text
      .decodeAuto({bytes: names.archive, offset: 0})
      .replace(/\0.*$/s, '');
    const moduleText = fixture.text
      .decodeAuto({bytes: names.module, offset: 0})
      .replace(/\0.*$/s, '');
    moduleNames.push({archive: archiveText, module: moduleText});
    console.log(
      JSON.stringify({
        game: basename(root),
        phase: 'selected-module',
        archive: archiveText,
        module: moduleText,
      }),
    );

    const childId = await timeout(
      fixture.core.loader.appendSelectedProgram(names.archive, names.module),
      timeoutMs,
      'module load',
    );
    if (!childId) throw new Error('Native loader returned no child for the selected module');
    fixture.core.gate.beginSuccessfulBoot(childId);

    const interpreter = runner.interpreter.interpreter;
    const originalStep = interpreter.step.bind(interpreter);
    interpreter.step = (thread, actor) => {
      if (opcodeCount >= maxOpcodes) throw new Error(`Opcode budget ${maxOpcodes} reached`);
      const opcode = thread.moduleMemory[thread.pc] ?? 0;
      instructionTail.push({
        pc: `0x${thread.pc.toString(16)}`,
        opcode: `0x${opcode.toString(16).padStart(2, '0')}`,
        ...((
          engineVersion.bpAbi.compatibility === '1.69'
            ? opcode >= 0x80
            : (opcode >= 0x7f && opcode <= 0xe0) || opcode === 0xff
        )
          ? {
              secondary: `0x${(thread.moduleMemory[thread.pc + 1] ?? 0).toString(16).padStart(2, '0')}`,
            }
          : {}),
      });
      if (instructionTail.length > 8) instructionTail.shift();
      const result = originalStep(thread, actor);
      opcodeCount++;
      opcodeCounts.set(opcode, (opcodeCounts.get(opcode) ?? 0) + 1);
      return result;
    };

    outcome = 'running';
    const startedAt = Date.now();
    let previousFrameState = '';
    while (frameCount < maxFrames && fixture.core.scheduler.firstThread !== null) {
      if (Date.now() - startedAt >= timeoutMs) {
        outcome = 'time-budget';
        break;
      }
      // A headless frame still consumes simulated wall time, including frames with no opcodes.
      now += frameMs;
      const frame = await timeout(runner.frames.tick(), timeoutMs, `frame ${frameCount + 1}`);
      frameCount++;
      const thread = fixture.core.scheduler.firstThread;
      const frameState = `${thread?.state.id}:${thread?.state.pc}:${thread?.process?.constructor?.name}`;
      if (frameCount <= 4 || frameState !== previousFrameState || frameCount % 120 === 0)
        console.log(
          JSON.stringify({
            game: basename(root),
            event: 'frame',
            n: frameCount,
            retireChildren: frame.retireChildren,
            opcodes: opcodeCount,
            opcodeCounts: Object.fromEntries(
              [...opcodeCounts].map(([op, count]) => [
                `0x${op.toString(16).padStart(2, '0')}`,
                count,
              ]),
            ),
            liveThread: thread?.state.id ?? null,
            pc: thread ? `0x${thread.state.pc.toString(16)}` : null,
            threadFlags: thread?.flags ?? null,
            waitProcess: thread?.process?.constructor?.name ?? null,
          }),
        );
      previousFrameState = frameState;
      if (frame.retireChildren) {
        if (fixture.graph.resource.scripts.hasLiveSection)
          await fixture.graph.resource.closeProgramScripts();
        fixture.core.scheduler.removeAllChildren();
        outcome = 'child-retired';
        break;
      }
    }
    if (outcome === 'running')
      outcome = fixture.core.scheduler.firstThread === null ? 'no-live-thread' : 'frame-budget';
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    error = /[\u3040-\u30ff\u3400-\u9fff]/u.test(message)
      ? `${caught instanceof Error ? caught.name : 'Error'} (localized dialog detail suppressed)`
      : message;
    if (caught instanceof Error)
      errorFrames = (caught.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line));
    outcome = 'error';
  } finally {
    if (runner?.instanceLease) {
      try {
        runner.instanceLease.release();
      } catch {}
    }
    if (fixture !== undefined) {
      try {
        await timeout(fixture.close(), timeoutMs, 'fixture cleanup');
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        error ??= /[\u3040-\u30ff\u3400-\u9fff]/u.test(message)
          ? `${caught instanceof Error ? caught.name : 'Error'} (localized dialog detail suppressed)`
          : message;
      }
    }
  }

  console.log(
    JSON.stringify({
      game: basename(root),
      outcome,
      frames: frameCount,
      opcodes: opcodeCount,
      opcodeCounts: Object.fromEntries(
        [...opcodeCounts].map(([op, count]) => [`0x${op.toString(16).padStart(2, '0')}`, count]),
      ),
      modules: moduleNames,
      dialogs,
      error,
      ...(error === null ? {} : {errorFrames, instructionTail}),
    }),
  );
}

for (const root of roots) {
  try {
    await probe(root);
  } catch (error) {
    console.log(
      JSON.stringify({
        game: basename(resolve(root)),
        outcome: 'probe-error',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
