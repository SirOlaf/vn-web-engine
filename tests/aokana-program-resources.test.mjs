import test from 'node:test';
import assert from 'node:assert/strict';
import {SourceFileSystem} from '../dist/platform/filesystem.js';
import {WindowsFileSystem, windowsFileKey} from '../dist/platform/windows-filesystem.js';
import {BlobSource} from '../dist/core/source.js';
import {BurikoNativeText} from '../dist/engines/buriko/native/text.js';
import {
  BurikoProgramFiles,
  BurikoProgramMedia,
} from '../dist/engines/buriko/native/program-files.js';
import {BurikoProgramResources} from '../dist/engines/buriko/native/program-resources.js';
import {BurikoEngineErrors} from '../dist/engines/buriko/native/engine-errors.js';
import {
  BurikoEngineDialogs,
  BurikoNativeCursor,
} from '../dist/engines/buriko/native/engine-dialogs.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoNativeInput} from '../dist/engines/buriko/native/input.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {
  decodeBurikoResource as decodeWithProcessing,
  BurikoUndefinedResourceRead,
} from '../dist/engines/buriko/native/resource-decode.js';
import {decodeBurikoBfFrame as frameWithProcessing} from '../dist/engines/buriko/native/bf-frame.js';
import {decodeBurikoCompressedBgV2 as cbgWithProcessing} from '../dist/engines/buriko/native/compressed-bg-v2.js';
import {randomByteGenerator} from '../dist/formats/buriko/binary.js';
import {BurikoBpThread, push32, pop32} from '../dist/engines/buriko/bp/state.js';
import {BurikoBpScheduler} from '../dist/engines/buriko/bp/scheduler.js';
import {BurikoBpMemory} from '../dist/engines/buriko/bp/memory.js';
import {BurikoVmControlState} from '../dist/engines/buriko/native/group-80-threads.js';
import {createGroup80Resources} from '../dist/engines/buriko/native/group-80-resources.js';
import {createGroupC0Bwef} from '../dist/engines/buriko/native/group-c0-bwef.js';
import {
  BurikoDistributedAllocator,
  BurikoDistributedProcessing,
} from '../dist/engines/buriko/native/distributed-processing.js';
const allocator = new BurikoDistributedAllocator(2);
const mainProcessing = new BurikoDistributedProcessing(allocator, 2);
const decodeBurikoResource = (bytes, offset, length) =>
  decodeWithProcessing(bytes, mainProcessing, offset, length);
const decodeBurikoBfFrame = (bytes, width, height, depth, quantization, destination) =>
  frameWithProcessing(
    bytes,
    width,
    height,
    depth,
    quantization,
    new BurikoDistributedProcessing(allocator, 2),
    destination,
  );
const decodeBurikoCompressedBgV2 = (bytes) =>
  cbgWithProcessing(bytes, new BurikoDistributedProcessing(allocator, 2));
const bytes = (s) => new TextEncoder().encode(s);
const put = (b, o, n) => new DataView(b.buffer, b.byteOffset, b.byteLength).setUint32(o, n, true);
function setup(present = async () => 1) {
  const sources = new SourceFileSystem(windowsFileKey);
  const fs = new WindowsFileSystem(sources, {
    cwd: 'C:\\game',
    mounts: [{windows: 'C:\\', virtual: '/'}],
  });
  const text = new BurikoNativeText(),
    media = new BurikoProgramMedia();
  media.setDriveType(2, 3);
  const files = new BurikoProgramFiles(fs, text, media);
  const clock = new BurikoNativeClock(() => 100);
  const display = new BurikoNativeDisplayState(1920, 1080),
    input = new BurikoNativeInput(display, clock);
  const dialogs = new BurikoEngineDialogs(
    {show: present},
    text,
    clock,
    input,
    new BurikoNativeCursor({style: {}}),
    {
      isPresent: () => false,
      refresh() {
        throw Error('Unexpected refresh');
      },
    },
    display,
    null,
    bytes('Game'),
  );
  const errors = new BurikoEngineErrors(files, dialogs, bytes('C:\\game\\'), bytes('C:\\game\\'));
  const resources = new BurikoProgramResources(
    files,
    {
      nativeFileRoot: 'C:\\game\\',
      primaryRoot: bytes('C:\\game\\'),
      secondaryRoot: bytes('C:\\disc\\'),
      secondaryMediaPath: 'C:\\disc\\',
      searchDirectoriesEnabled: 0,
      searchDirectories: [],
      retryTitle: bytes('Media'),
      retryMessage: bytes('Insert'),
      quitConfirmation: bytes('Quit?'),
    },
    dialogs,
    errors,
    mainProcessing,
  );
  return {
    sources,
    files,
    resources,
    media,
    errors,
    mount(path, data) {
      sources.attach(path, new BlobSource(new Blob([data])));
    },
  };
}
function archive(entries, packed = false) {
  const record = packed ? 32 : 128,
    base = 16 + entries.length * record;
  const output = new Uint8Array(base + entries.reduce((sum, e) => sum + e.data.length, 0));
  output.set(bytes(packed ? 'PackFile    ' : 'BURIKO ARC20'));
  put(output, 12, entries.length);
  let offset = 0;
  entries.forEach((entry, index) => {
    output.set(entry.name, 16 + index * record);
    put(output, 16 + index * record + (packed ? 16 : 96), offset);
    put(output, 16 + index * record + (packed ? 20 : 100), entry.data.length);
    if (!packed)
      new DataView(output.buffer).setBigUint64(
        16 + index * record + 104,
        entry.metadata ?? 0n,
        true,
      );
    output.set(entry.data, base + offset);
    offset += entry.data.length;
  });
  return output;
}
test('native drive gate distinguishes fixed, nonfixed, UNC and relative paths', () => {
  const s = setup();
  assert.equal(s.files.isAvailable(bytes('C:\\missing')), true);
  assert.equal(s.files.isAvailable(bytes('relative')), false);
  assert.equal(s.files.isAvailable(bytes('\\single')), false);
  assert.equal(s.files.isAvailable(bytes('\\\\server\\share')), true);
  s.media.setDriveType(2, 4);
  assert.equal(s.files.isAvailable(bytes('C:\\x')), false);
  s.media.volumePresent[2] = 1;
  assert.equal(s.files.isAvailable(bytes('C:\\x')), true);
  s.media.volumePresent[2] = 0;
  s.media.operatingSystemType = 1;
  assert.equal(s.files.isAvailable(bytes('C:\\x')), true);
});
test('ARC20 and PackFile normalize raw names, preserve first duplicates, and retain metadata', async () => {
  for (const packed of [false, true]) {
    const s = setup();
    const name = s.files.text.encodeWide('あABC', 0);
    s.mount(
      '/game/data.arc',
      archive(
        [
          {name, data: Uint8Array.of(1, 2), metadata: 0xfeedn},
          {name: bytes('あabc'), data: Uint8Array.of(9)},
        ],
        packed,
      ),
    );
    const nameUtf8 = bytes('あabc');
    assert.equal(await s.resources.archives.size(bytes('C:\\GAME\\DATA.ARC'), nameUtf8), 2);
    assert.deepEqual(
      (await s.resources.archives.read(bytes('C:\\game\\data.arc'), nameUtf8)).bytes,
      Uint8Array.of(1, 2),
    );
    assert.equal(
      await s.resources.archives.metadata(bytes('C:\\game\\data.arc'), nameUtf8),
      packed ? 0n : 0xfeedn,
    );
  }
});
test('archive index stays cached while payload reads reopen the mounted file', async () => {
  const s = setup(),
    path = bytes('C:\\game\\a.arc'),
    name = bytes('x');
  s.mount('/game/a.arc', archive([{name, data: Uint8Array.of(3, 4)}]));
  assert.equal(await s.resources.archives.size(path, name), 2);
  s.mount('/game/a.arc', archive([{name: bytes('renamed'), data: Uint8Array.of(5, 6, 7)}]));
  assert.deepEqual((await s.resources.archives.read(path, name)).bytes, Uint8Array.of(5, 6));
  assert.equal((await s.resources.archives.read(path, name, 0, 3)).result, 0x80000040);
  assert.equal((await s.resources.archives.read(path, name, 1, 2)).result, 0x80000030);
  s.resources.archives.clear();
  assert.equal(await s.resources.archives.size(path, name), 0x80000020);
});
test('resource priority is primary loose then archive; subdirectories only follow missing relative loose paths', async () => {
  const s = setup();
  s.mount('/game/a.arc', archive([{name: bytes('x'), data: Uint8Array.of(9)}]));
  s.mount('/game/x', Uint8Array.of(1));
  assert.deepEqual(
    await s.resources.readModule(bytes('a.arc'), bytes('x'), false),
    Uint8Array.of(1),
  );
  s.resources.configuration.searchDirectoriesEnabled = 1;
  s.resources.configuration.searchDirectories.push(bytes('sub'));
  s.mount('/game/sub/y', Uint8Array.of(2));
  assert.deepEqual(await s.resources.readModule(null, bytes('y'), false), Uint8Array.of(2));
  s.mount('/disc/z', Uint8Array.of(3));
  assert.deepEqual(await s.resources.readModule(null, bytes('z'), false), Uint8Array.of(3));
  assert.equal(await s.resources.readModule(null, bytes('C:\\absent'), false), null);
});
test('size-query rejects primary missing archive without bd7d0 secondary-entry fallback', async () => {
  const s = setup();
  s.mount('/disc/a.arc', archive([{name: bytes('x'), data: Uint8Array.of(9)}]));
  assert.equal(await s.resources.size(bytes('a.arc'), bytes('x')), 0);
  assert.deepEqual(
    await s.resources.readModule(bytes('a.arc'), bytes('x'), false),
    Uint8Array.of(9),
  );
});
test('deferred archive pointers are consumed only after a primary loose miss, including BWEF loads', async () => {
  const s = setup(),
    content = new Uint8Array(0x124);
  content.set(bytes('bwef    '));
  put(content, 0x14, 1);
  put(content, 0x18, 17);
  put(content, 0x120, 100);
  s.mount('/game/x', content);
  let reads = 0;
  const deferred = () => {
    reads++;
    return bytes('missing.arc');
  };
  assert.equal(await s.resources.size(deferred, bytes('x')), content.length);
  assert.equal((await s.resources.load(deferred, bytes('x'), false)).result, content.length);
  assert.equal(reads, 0);
  assert.equal(await s.resources.size(deferred, bytes('missing')), 0);
  assert.equal(reads, 1);
  const memory = new BurikoBpMemory(new Uint8Array(256)),
    thread = new BurikoBpThread({id: 1, operandCapacity: 16, moduleCapacity: 0, frameCapacity: 0});
  memory.globalMemory.set(bytes('x\0'), 32);
  // A non-null archive pointer outside its bank remains unused on both successful loose reads.
  [64, 96, 0x01000000, 32, 23].forEach((value) => push32(thread, value));
  assert.equal(await createGroupC0Bwef(s.resources)[0].execute({memory, thread}), 0);
  assert.equal(pop32(thread), 0);
  assert.equal(thread.stackIndex, 0);
  assert.deepEqual([...new Int32Array(memory.globalMemory.buffer, 64, 2)], [123, 17]);
  assert.equal(new DataView(memory.globalMemory.buffer).getUint32(96, true), 1);
  s.resources.configuration.secondaryMediaPath = 'D:\\';
  reads = 0;
  await assert.rejects(
    s.resources.load(
      () => {
        if (++reads === 2) throw new Error('native retry format reads archive');
        return bytes('missing.arc');
      },
      bytes('missing'),
      true,
    ),
    /native retry format reads archive/,
  );
  assert.equal(reads, 2);
});
test('resource retry cancellation preserves native quit code and follows both dialogs', async () => {
  const calls = [];
  const s = setup(async (dialog) => {
    calls.push(dialog);
    return calls.length === 1 ? 2 : 6;
  });
  await assert.rejects(
    s.resources.readModule(null, bytes('missing')),
    (error) => error.code === 0x7fffffff,
  );
  assert.deepEqual(
    calls.map((c) => [c.text, c.buttons, c.defaultSecondButton]),
    [
      ['Insert', 'ok-cancel', false],
      ['Quit?', 'yes-no', true],
    ],
  );
});
test('asset decoder keeps raw BSE/SDC and precise unsigned slice statuses', async () => {
  const input = bytes('BSE 1.0\0unchanged');
  assert.deepEqual((await decodeBurikoResource(input)).bytes, input);
  assert.equal((await decodeBurikoResource(input, 0, input.length + 1)).status, 3);
  assert.equal((await decodeBurikoResource(input, 1, input.length)).status, 2);
  await assert.rejects(decodeBurikoResource(input, 0xffffffff, 1), BurikoUndefinedResourceRead);
});
function varint(n) {
  const out = [];
  do {
    const low = n & 127;
    n >>>= 7;
    out.push(low | (n ? 128 : 0));
  } while (n);
  return out;
}
function frame(
  depth,
  count = depth === 8 ? 64 : depth === 16 ? 128 : 192,
  mask = 1,
  alphaMode = 1,
) {
  const head = new Uint8Array(200);
  head[0] = head[16] = 1;
  put(head, 192, 200);
  const row = Uint8Array.from([mask, ...varint(count), 0, 0, 0]);
  put(head, 196, 200 + row.length);
  let alpha = [];
  if (depth === 32) {
    if (alphaMode === 1) alpha = [1, 0, 0, 0, 2, 170, 63, 120];
    else {
      const weights = new Array(256).fill(0);
      weights[1] = 65;
      alpha = [2, 0, 0, 0, 65, 0, 0, 0, ...weights, ...new Array(9).fill(0)];
    }
  }
  return Uint8Array.from([...head, ...row, ...alpha]);
}
test('BF alpha workers use the descriptor extent while retaining a larger backing allocation', () => {
  for (const [depth, mode] of [
    [24, 1],
    [32, 1],
    [32, 2],
  ]) {
    const surface = {
      bytes: new Uint8Array(272).fill(0xa5),
      initialized: new Uint8Array(272).fill(1),
    };
    decodeBurikoBfFrame(
      frame(depth, undefined, 1, mode),
      8,
      8,
      depth,
      new Uint8Array(128).fill(1),
      surface,
    );
    assert.deepEqual(surface.bytes.subarray(256), new Uint8Array(16).fill(0xa5));
    assert.deepEqual(surface.initialized.subarray(256), new Uint8Array(16).fill(1));
  }
});
function cbg(depth, payload = frame(depth)) {
  const input = new Uint8Array(176 + payload.length);
  input.set(bytes('CompressedBG___\0'));
  const data = new DataView(input.buffer);
  data.setUint16(16, 2, true);
  data.setUint16(18, 1, true);
  data.setUint16(20, depth, true);
  data.setUint16(46, 2, true);
  put(input, 36, 1);
  put(input, 40, 128);
  const next = randomByteGenerator(1);
  for (let i = 0; i < 128; i++) input[48 + i] = (1 + next()) & 255;
  input[44] = 128;
  input[45] = 0;
  input.set(payload, 176);
  return input;
}
test('native BF grayscale, RGB and both alpha modes use the verified reconstruction and retained masks', () => {
  const quantization = new Uint8Array(128).fill(1);
  for (const depth of [8, 24, 32])
    for (const alpha of [1, 2]) {
      const result = decodeBurikoBfFrame(
        frame(depth, undefined, 1, alpha),
        8,
        8,
        depth,
        quantization,
      );
      for (let offset = 0; offset < 256; offset += 4)
        assert.deepEqual(Array.from(result.bytes.subarray(offset, offset + 4)), [
          128,
          128,
          128,
          depth !== 32 ? 0 : alpha === 1 ? 170 : 1,
        ]);
      assert.equal(result.initialized.includes(0), false);
      const retained = decodeBurikoBfFrame(
        frame(depth, 0, 1, alpha),
        8,
        8,
        depth,
        quantization,
        result,
      );
      assert.deepEqual(retained.bytes, result.bytes);
    }
  assert.throws(
    () => decodeBurikoBfFrame(frame(16), 8, 8, 16, quantization),
    BurikoUndefinedResourceRead,
  );
});
test('CBG v2 preserves crop bytes, depth24 unwritten allocation tail and zero-count retained output', async () => {
  const gray = await decodeBurikoResource(cbg(8));
  assert.equal(gray.status, 0);
  assert.deepEqual(Array.from(gray.bytes.subarray(16)), [128, 128]);
  const rgba = await decodeBurikoResource(cbg(32));
  assert.equal(rgba.status, 0);
  assert.deepEqual(Array.from(rgba.bytes.subarray(16)), [128, 128, 128, 170, 128, 128, 128, 170]);
  const rgb = await decodeBurikoCompressedBgV2(cbg(24));
  assert.equal(rgb.bytes.length, 24);
  assert.equal(rgb.initializedLength, 22);
  assert.equal((await decodeBurikoResource(cbg(24), 16, 6)).status, 0);
  await assert.rejects(decodeBurikoResource(cbg(24)), BurikoUndefinedResourceRead);
  await assert.rejects(decodeBurikoResource(cbg(8, frame(8, 0, 1))), BurikoUndefinedResourceRead);
});
test('8040 appends the module and 8044 links an independently allocated runnable thread', async () => {
  const s = setup(),
    module = new Uint8Array(20);
  put(module, 0, 16);
  put(module, 4, 4);
  module.set([1, 2, 3, 4], 16);
  s.mount('/game/program', module);
  const control = new BurikoVmControlState(),
    root = new BurikoBpThread({
      id: control.allocateThreadId(),
      operandCapacity: 32,
      moduleCapacity: 64,
      frameCapacity: 64,
    });
  const scheduler = new BurikoBpScheduler(root, () => 1),
    memory = new BurikoBpMemory(new Uint8Array(64));
  memory.globalMemory.set(bytes('program\0'), 4);
  const slots = new Map(
    createGroup80Resources(scheduler, control, s.resources).map((slot) => [slot.secondary, slot]),
  );
  const context = {thread: root, memory};
  push32(root, 0);
  push32(root, 4);
  assert.equal(await slots.get(0x40).execute(context), 0);
  assert.equal(pop32(root), 0);
  assert.deepEqual(root.moduleMemory.subarray(0, 4), Uint8Array.of(1, 2, 3, 4));
  for (const value of [0, 4, 32, 128, 256]) push32(root, value);
  assert.equal(await slots.get(0x44).execute(context), 0);
  assert.equal(pop32(root), 1);
  assert.equal(scheduler.firstThread.state.frameMemory.length, 256);
  assert.equal(scheduler.firstThread.state.moduleMemory.length, 128);
  assert.equal(scheduler.firstThread.state.operandStack.length, 32);
});

test('8040 and 8044 retain the invoking actor and module name across mounted reads', async () => {
  const s = setup(),
    module = new Uint8Array(20);
  put(module, 0, 16);
  put(module, 4, 4);
  module.set([1, 2, 3, 4], 16);
  const physical = new BlobSource(new Blob([module]));
  let enteredRead, releaseRead, readEntered, readGate;
  s.sources.attach('/game/program', {
    size: physical.size,
    async read(offset, length) {
      enteredRead();
      await readGate;
      return physical.read(offset, length);
    },
  });
  const actor = {},
    ordinaryActor = allocator.currentActor;
  const seen = [],
    load = s.resources.load.bind(s.resources);
  s.resources.load = (...args) => {
    seen.push({name: args[1], actor: args[4]});
    return load(...args);
  };
  const control = new BurikoVmControlState();
  const root = new BurikoBpThread({
    id: control.allocateThreadId(),
    operandCapacity: 32,
    moduleCapacity: 64,
    frameCapacity: 64,
  });
  const scheduler = new BurikoBpScheduler(root, () => 1),
    memory = new BurikoBpMemory(new Uint8Array(64));
  const slots = new Map(
    createGroup80Resources(scheduler, control, s.resources).map((slot) => [slot.secondary, slot]),
  );
  const invoke = async (secondary, arguments_) => {
    readEntered = new Promise((resolve) => {
      enteredRead = resolve;
    });
    readGate = new Promise((resolve) => {
      releaseRead = resolve;
    });
    memory.globalMemory.set(bytes('program\0'), 4);
    for (const value of arguments_) push32(root, value);
    const pending = slots.get(secondary).execute({thread: root, memory, actor});
    await readEntered;
    assert.equal(allocator.currentActor, ordinaryActor);
    memory.globalMemory.set(bytes('badname\0'), 4);
    releaseRead();
    assert.equal(await pending, 0);
    assert.equal(seen.at(-1).actor, actor);
    assert.deepEqual(seen.at(-1).name, bytes('program'));
    return pop32(root);
  };
  assert.equal(await invoke(0x40, [0, 4]), 0);
  assert.deepEqual(root.modules[0].name, bytes('program'));
  assert.equal(await invoke(0x44, [0, 4, 32, 128, 256]), 1);
  assert.deepEqual(scheduler.firstThread.state.modules[0].name, bytes('program'));
  assert.equal(root.stackIndex, 0);
  assert.equal(seen.length, 2);
});

test('native BF color conversion reads four-word groups of partial third planes and preserves LUT indices', () => {
  const result = decodeBurikoBfFrame(frame(16, 191), 1, 1, 16, new Uint8Array(128).fill(1));
  assert.equal(result.initialized.includes(0), false);
  // Third plane begins at176; cleared coefficient0 is used as Cr, without IDCT conversion.
  assert.deepEqual(Array.from(result.bytes), [128, 219, 0, 0]);
});

test('native entropy preserves numeric lookahead faults and resolves only defined short symbols', async () => {
  const {BurikoBfBits, burikoBfTree, burikoBfSymbol, burikoBfSignedBits, burikoBfVarint} =
    await import('../dist/engines/buriko/native/bf-entropy.js');
  const tree = burikoBfTree([1, 0]),
    bits = new BurikoBfBits(Uint8Array.of(0));
  assert.equal(burikoBfSymbol(bits, tree), 0);
  assert.equal(bits.position, 1);
  assert.throws(() => bits.peekByte(), BurikoUndefinedResourceRead);
  for (let i = 1; i < 8; i++) assert.equal(burikoBfSymbol(bits, tree), 0);
  assert.throws(() => burikoBfSymbol(bits, tree), BurikoUndefinedResourceRead);
  const empty = new BurikoBfBits(new Uint8Array());
  assert.throws(() => burikoBfSignedBits(empty, 0), BurikoUndefinedResourceRead);
  assert.equal(burikoBfVarint(Uint8Array.of(128, 128, 128, 128, 128, 1), {position: 0}), 8);
  const resource = cbg(8),
    truncated = resource.subarray(0, resource.length - 2);
  await assert.rejects(decodeBurikoResource(truncated), BurikoUndefinedResourceRead);
  const header = bytes('CompressedBG___\0');
  await assert.rejects(decodeBurikoResource(header), BurikoUndefinedResourceRead);
});

test('resource BF final short codes do not consume speculative lookahead outside the payload', async () => {
  const padded = frame(24),
    exact = padded.subarray(0, padded.length - 1),
    expected = await decodeBurikoResource(cbg(24, padded), 16, 6),
    result = await decodeBurikoResource(cbg(24, exact), 16, 6);
  assert.equal(result.status, 0);
  assert.deepEqual(result.bytes, expected.bytes);
  // Removing an actually consumed coefficient byte remains an undefined native read.
  await assert.rejects(
    decodeBurikoResource(cbg(24, exact.subarray(0, exact.length - 1)), 16, 6),
    BurikoUndefinedResourceRead,
  );
});
