import assert from 'node:assert/strict';
import test from 'node:test';
import {pop32} from '../dist/engines/buriko/games/aokana/bp/state.js';
import {BrowserWindowsFileAssociationHost} from '../dist/platform/windows-file-associations.js';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

const bytes = (value) => new TextEncoder().encode(`${value}\0`);
const wide = (value) => {
  const result = new Uint8Array((value.length + 1) * 2),
    view = new DataView(result.buffer);
  for (let index = 0; index < value.length; index++)
    view.setUint16(index * 2, value.charCodeAt(index), true);
  return result;
};

test('mounted 80:FC uses the graph browser host and reports registration plus notifications', async () => {
  const fixture = await createMountedVmFixture();
  try {
    const {graph, memory, child, definitions, invoke} = fixture,
      host = graph.fileAssociationHost;
    assert.ok(host instanceof BrowserWindowsFileAssociationHost);
    assert.equal(graph.fileAssociations.host, host);
    assert.equal(graph.fileAssociations.text, graph.text);
    assert.equal(
      definitions.filter(({primary, secondary}) => primary === 0x80 && secondary === 0xfc).length,
      1,
    );

    const values = [
      [0x100, 'vnx'],
      [0x140, 'Aokana.Document'],
      [0x180, 'Aokana document'],
      [0x1c0, 'Aokana.exe,0'],
      [0x200, '"Aokana.exe" "%1"'],
    ];
    for (const [address, value] of values) memory.globalMemory.set(bytes(value), address);
    assert.equal(
      await invoke(
        0x80,
        0xfc,
        values.map(([address]) => address),
        0,
      ),
      1,
    );
    assert.equal(pop32(child.state), 1);
    assert.equal(child.state.stackIndex, 0);

    assert.deepEqual(host.value('.vnx'), {type: 1, data: wide('Aokana.Document')});
    assert.deepEqual(host.value('Aokana.Document'), {type: 1, data: wide('Aokana document')});
    assert.deepEqual(host.value('Aokana.Document\\DefaultIcon'), {
      type: 1,
      data: wide('Aokana.exe,0'),
    });
    assert.deepEqual(host.value('Aokana.Document\\Shell\\Open\\Command'), {
      type: 1,
      data: wide('"Aokana.exe" "%1"'),
    });
    assert.deepEqual(host.notifications, [
      {kind: 'setting-change', window: 0xffff, message: 0x1a, wParam: 0x2e, lParam: 0},
      {kind: 'shell-change', event: 0x08000000, flags: 0x3000},
    ]);
  } finally {
    await fixture.close();
  }
});
