import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NoahState} from '../dist/engines/mages/games/chaos-head-noah/sc3/noah-state.js';
import {noahMenuAllowsSidebar} from '../dist/engines/mages/games/chaos-head-noah/sc3/menu-presentation.js';

test('sidebar follows title menus but excludes reveal, opening and unused phases', () => {
  const s = new NoahState(() => 0);
  s.flags[0x9b] |= 1;
  for (let phase = 0; phase <= 16; phase++) {
    s.setVariable(0x210c / 4, phase);
    assert.equal(
      noahMenuAllowsSidebar(s),
      [1, 2, 3, 4, 5, 10, 11, 12, 15].includes(phase),
      `title phase ${phase}`,
    );
  }
});
test('story and closed menus stay clean; in-game menu fades expose the sidebar', () => {
  const s = new NoahState(() => 0);
  assert.equal(noahMenuAllowsSidebar(s), false);
  for (const progress of [1, 16, 32]) {
    s.setVariable(0x2178 / 4, progress);
    assert.equal(noahMenuAllowsSidebar(s), true);
  }
  s.setVariable(0x2178 / 4, 0);
  assert.equal(noahMenuAllowsSidebar(s), false);
  // A stale overlay ID / opacity alone is not an active menu.
  s.setVariable(0x2190 / 4, 5);
  s.setVariable(0x2194 / 4, 255);
  assert.equal(noahMenuAllowsSidebar(s), false);
});
test('direct destinations respect native enable, fade and switch gates without writes', () => {
  const s = new NoahState(() => {
    throw new Error('Observer must not consume randomness');
  });
  s.flags[0x99] |= 16;
  s.setVariable(0x2194 / 4, 255);
  for (let overlay = 0; overlay <= 15; overlay++) {
    s.setVariable(0x2190 / 4, overlay);
    const before = s.regions.map((r) => r.bytes.slice());
    assert.equal(noahMenuAllowsSidebar(s), ![6, 13, 15].includes(overlay), `overlay ${overlay}`);
    s.regions.forEach((r, i) => assert.deepEqual(r.bytes, before[i]));
  }
  s.setVariable(0x2190 / 4, 5);
  s.setVariable(0x2194 / 4, 0);
  assert.equal(noahMenuAllowsSidebar(s), false);
});

test('inactive native draw contexts cannot expose the sidebar through stale menu state', async () => {
  const {runtime} = await import('./sc3-fixtures.mjs');
  const {captureStartupFrame} =
    await import('../dist/engines/mages/games/chaos-head-noah/sc3/startup-frame.js');
  const vm = runtime([0, 3]);
  await vm.boot();
  vm.state.flags[0x9b] |= 1;
  vm.state.setVariable(0x210c / 4, 3);
  assert.equal(noahMenuAllowsSidebar(vm.state), true);
  for (let i = 0; i < 12; i++) vm.state.put(0x17ab880 + i * 4, 0);
  assert.equal(captureStartupFrame(vm, 1).menuAllowsSidebar, false);
});

test('native menu context publishes availability and clears it when the context is hidden', async () => {
  const {runtime} = await import('./sc3-fixtures.mjs');
  const {captureStartupFrame} =
    await import('../dist/engines/mages/games/chaos-head-noah/sc3/startup-frame.js');
  const vm = runtime([0, 3]);
  await vm.boot();
  for (let i = 0; i < 12; i++) vm.state.put(0x17ab880 + i * 4, 0);
  const c = vm.context(0);
  vm.state.put(0x17ab880, 0x20000000);
  c.setUint32(0, c.getUint32(0, true) | 0x20000000, true);
  c.setInt32(0x84, 10, true);
  vm.state.flags[0x9b] |= 1;
  vm.state.setVariable(0x210c / 4, 1);
  vm.textures.createRgba(3, 1, 1); // Synthetic placeholder; no original game pixels.
  assert.equal(captureStartupFrame(vm, 1).menuAllowsSidebar, true);
  vm.state.put(0x17ab880, 0);
  assert.equal(captureStartupFrame(vm, 2).menuAllowsSidebar, false);
});
