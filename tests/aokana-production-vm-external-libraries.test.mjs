import test from 'node:test';
import assert from 'node:assert/strict';
import {pop32} from '../dist/engines/buriko/bp/state.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('selected 80:EC/ED/EE registry uses native DLL exports and borrowed callback arguments', async () => {
  const events = [];
  const windowHandle = {nativeWindow: true};
  let fixture;
  const host = {
    loadLibraryA(path) {
      const name = new TextDecoder().decode(path);
      events.push(['load', name]);
      return name.endsWith('missing.dll\0') ? null : {name};
    },
    getProcAddress(library, name) {
      events.push(['export', library.name, name]);
      if (library.name.endsWith('bad.dll\0') && name === 'CallFunctionForEthornell') return null;
      return {name};
    },
    mainWindowHandle(identity) {
      assert.equal(identity, fixture.graph.host);
      return windowHandle;
    },
    invoke(procedure, args) {
      if (procedure.name === 'SetWindowHandleOfEthornell') {
        assert.deepEqual(args, [{kind: 'handle', value: windowHandle}]);
        events.push([
          'set-window',
          new DataView(fixture.memory.globalMemory.buffer).getUint32(0x100, true),
        ]);
        return;
      }
      assert.equal(procedure.name, 'CallFunctionForEthornell');
      assert.equal(args[0].kind, 'signed');
      assert.equal(args[0].value, -7n);
      assert.equal(args[1].kind, 'memory');
      assert.equal(args[1].pointer.bytes, fixture.memory.globalMemory);
      assert.equal(args[1].pointer.offset, 0x300);
      assert.deepEqual(args[2], {kind: 'signed', value: -3n});
      args[1].pointer.bytes[args[1].pointer.offset] = 0x5a;
      events.push(['call']);
      return 0x123456789abcdef0n;
    },
    freeLibrary(library) {
      events.push(['free', library.name]);
    },
  };
  fixture = await createMountedVmFixture({dynamicLibraryHost: host});
  const {graph, memory, invoke, child} = fixture;
  try {
    assert.equal(graph.externalLibraries.host, host);
    assert.equal(graph.externalLibraries.resources, graph.resource.resources);
    assert.equal(graph.externalLibraries.windowIdentity, graph.host);
    for (const secondary of [0xec, 0xed, 0xee])
      assert.ok(
        fixture.definitions.some((slot) => slot.primary === 0x80 && slot.secondary === secondary),
      );

    memory.globalMemory.set(new TextEncoder().encode('missing.dll\0'), 0x200);
    assert.equal(await invoke(0x80, 0xec, [0x100, 0x200], 0), 1);
    assert.equal(pop32(child.state), 1);
    memory.globalMemory.set(new TextEncoder().encode('bad.dll\0'), 0x200);
    assert.equal(await invoke(0x80, 0xec, [0x100, 0x200], 0), 1);
    assert.equal(pop32(child.state), 2);
    assert.equal(new DataView(memory.globalMemory.buffer).getUint32(0x100, true), 0);

    memory.globalMemory.set(new TextEncoder().encode('plugin.dll\0'), 0x200);
    assert.equal(await invoke(0x80, 0xec, [0x100, 0x200], 0), 1);
    assert.equal(pop32(child.state), 0);
    const id = new DataView(memory.globalMemory.buffer).getUint32(0x100, true);
    assert.equal(id, 1);
    memory.globalMemory[0x300] = 0x11;
    assert.equal(await invoke(0x80, 0xee, [0x400, id, 0xfffffff9, 0x300, 0xfffffffd, 1], 0), 1);
    assert.equal(pop32(child.state), 4);
    assert.equal(memory.globalMemory[0x300], 0x5a);
    assert.equal(new DataView(memory.globalMemory.buffer).getUint32(0x400, true), 0x9abcdef0);

    assert.equal(await invoke(0x80, 0xed, [id], 0), 1);
    assert.equal(pop32(child.state), 0);
    assert.equal(await invoke(0x80, 0xed, [id], 0), 1);
    assert.equal(pop32(child.state), 3);
    assert.equal(await invoke(0x80, 0xee, [0x400, id, 0, 0, 0, 0], 0), 1);
    assert.equal(pop32(child.state), 3);
    assert.equal(new DataView(memory.globalMemory.buffer).getUint32(0x400, true), 0x9abcdef0);
    assert.deepEqual(events.slice(-3), [
      ['set-window', 1],
      ['call'],
      ['free', 'C:\\game\\plugin.dll\0'],
    ]);
  } finally {
    await fixture.close();
  }
});
