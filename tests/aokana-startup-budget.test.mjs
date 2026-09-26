import test from 'node:test';
import assert from 'node:assert/strict';
import {BurikoCpuProfile} from '../dist/engines/buriko/native/cpu-profile.js';
import {BurikoNativeClock} from '../dist/engines/buriko/native/clock.js';
import {BurikoNativeDisplayState} from '../dist/engines/buriko/native/display-state.js';
import {
  burikoDisplayRenderPixelBudget,
  burikoStartupCpuLog,
} from '../dist/engines/buriko/native/startup-budget.js';

function setup(firstCache, secondCache, count, mask = 3n) {
  let ticks = 0,
    timestamps = 0;
  const cpu = new BurikoCpuProfile(
    {
      cpuid(leaf) {
        switch (leaf) {
          case 0:
            return [1, 0x68747541, 0x444d4163, 0x69746e65]; // AuthenticAMD.
          case 1:
            return [0x600, 0, 0, 1 << 26];
          case 0x80000000:
            return [0x80000006, 0, 0, 0];
          case 0x80000005:
            return [0, 0, (firstCache << 24) | 0x80040, 0];
          case 0x80000006:
            return [0, 0, (secondCache << 16) | 0x6040, 0];
          default:
            return [0, 0, 0, 0];
        }
      },
      readTimestampCounter: () => BigInt(timestamps++ % 2) * 2000000000n,
      setCurrentThreadAffinity: () => 3n,
      logicalProcessorCount: () => count,
      logicalProcessorInformation: () => [{relationship: 0, processorMask: mask}],
    },
    new BurikoNativeClock(() => (ticks += 125)),
  );
  assert.equal(cpu.initialize(), true);
  const calls = [];
  const read = cpu.read.bind(cpu),
    coreCount = cpu.firstCoreLogicalProcessorCount.bind(cpu);
  cpu.read = (index) => {
    calls.push(index);
    return read(index);
  };
  cpu.firstCoreLogicalProcessorCount = () => {
    calls.push('core');
    return coreCount();
  };
  class Display extends BurikoNativeDisplayState {
    get logicalWidth() {
      calls.push('width');
      return super.logicalWidth;
    }
    get logicalHeight() {
      calls.push('height');
      return super.logicalHeight;
    }
  }
  return {cpu, display: new Display(1920, 1080), calls};
}

test('startup budget consumes the same initialized CPU record in native branch and read order', () => {
  const cases = [
    [64, 512, 4, 6406, [5]],
    [32, 0, 4, 10240, [5, 9, 'height', 'width', 6]],
    [32, 512, 1, 38400, [5, 9, 'height', 'width', 6, 9]],
    [32, 512, 4, 19200, [5, 9, 'height', 'width', 6, 9, 'core']],
    [32, 256, 8, 9600, [5, 9, 'height', 'width', 6, 9, 'core']],
    [32, 2048, 16, 7200, [5, 9, 'height', 'width', 6, 9, 'core']],
  ];
  for (const [l1, l2, count, expected, reads] of cases) {
    const {cpu, display, calls} = setup(l1, l2, count);
    assert.equal(burikoDisplayRenderPixelBudget(cpu, display), expected);
    assert.deepEqual(calls, reads);
  }
});

test('startup budget uses the current mode and first core topology instead of total CPU count', () => {
  const {cpu, display} = setup(32, 512, 4, 1n);
  display.selectedSizePreset = 6; // 1280 by 720.
  assert.equal(burikoDisplayRenderPixelBudget(cpu, display), 38400);
  cpu.host.logicalProcessorInformation = () => [
    {relationship: 3, processorMask: 0xffn},
    {relationship: 0, processorMask: 3n},
    {relationship: 0, processorMask: 0xffn},
  ];
  assert.equal(burikoDisplayRenderPixelBudget(cpu, display), 19200);
});

test('the selected startup logarithm agrees with positive integer logarithms and binary powers', () => {
  assert.equal(burikoStartupCpuLog(1), 0);
  for (const count of [2, 3, 4, 7, 8, 15, 16, 24, 32, 48, 64, 96, 128])
    assert.ok(Math.abs(burikoStartupCpuLog(count) - Math.log(count)) < 2e-15);
  for (let exponent = 0; exponent <= 7; exponent++)
    assert.equal(Math.floor(burikoStartupCpuLog(2 ** exponent) / burikoStartupCpuLog(2)), exponent);
});
