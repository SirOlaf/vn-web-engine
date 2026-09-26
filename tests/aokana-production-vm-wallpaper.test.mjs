import assert from 'node:assert/strict';
import test from 'node:test';
import {createMountedVmFixture} from './aokana-production-vm-fixture.mjs';

test('mounted B0:F0 shares the selected desktop effect and graph registry', async () => {
  const calls = [];
  const desktopWallpaperHost = {
    async setWallpaper(path, flags) {
      calls.push([path, flags]);
      return true;
    },
  };
  const fixture = await createMountedVmFixture({desktopWallpaperHost});
  const {graph, definitions, memory, child, invoke} = fixture;
  try {
    assert.equal(graph.wallpaper.desktop, desktopWallpaperHost);
    assert.equal(graph.wallpaper.registry, graph.registry);
    assert.equal(graph.wallpaper.text, graph.text);
    assert.equal(
      definitions.filter(({primary, secondary}) => primary === 0xb0 && secondary === 0xf0).length,
      1,
    );
    memory.globalMemory.set(new TextEncoder().encode('C:\\game\\wallpaper.bmp\0'), 0x100);
    assert.equal(await invoke(0xb0, 0xf0, [0x100, 1, 0], 0), 0);
    assert.equal(child.state.stackIndex, 0);
    assert.deepEqual(calls, [['C:\\game\\wallpaper.bmp', 3]]);
    const key = {hive: 'HKCU', view: '64', path: 'control panel\\desktop'};
    assert.deepEqual((await graph.registry.storage.getValue(key, 'WallpaperStyle')).data, Uint8Array.of(50, 0, 0, 0));
    assert.deepEqual((await graph.registry.storage.getValue(key, 'TileWallpaper')).data, Uint8Array.of(48, 0, 0, 0));
    assert.equal(graph.registry.openHandleCount, 1);
  } finally {
    await fixture.close();
  }
});

test('partial graph selects browser desktop effect failure for B0:F0', async () => {
  const fixture = await createMountedVmFixture();
  try {
    assert.ok(fixture.graph.wallpaper);
    assert.equal(
      fixture.definitions.some(({primary, secondary}) => primary === 0xb0 && secondary === 0xf0),
      true,
    );
  } finally {
    await fixture.close();
  }
});
