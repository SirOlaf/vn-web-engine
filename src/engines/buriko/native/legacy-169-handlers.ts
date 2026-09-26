import {pop32, push32} from '../bp/state.js';
import type {BurikoCpuProfile} from './cpu-profile.js';
import type {BurikoSystemProfile, BurikoWindowsVersion} from './system-profile.js';
import type {BurikoSurfaces} from './surfaces.js';
import type {BurikoLegacy169FlashSurfaces} from './legacy-169-flash.js';
import {reduceLegacy169BitmapHalf} from './legacy-169-bitmap-reduce.js';
import type {BurikoBpOpcodeHandler, BurikoNativeSlotDefinition} from './types.js';

function osClass(version: BurikoWindowsVersion): number {
  const major = version.major >>> 0,
    minor = version.minor >>> 0;
  switch (version.platform >>> 0) {
    case 0:
      return 0x7000;
    case 1:
      if (major === 4) return minor === 0 ? 0x1000 : minor <= 10 ? 0x2000 : 0x3000;
      return major > 4 ? 0x3000 : 0xf000;
    case 2:
      if (major === 3) return 0x5000;
      if (major === 4) return 0x6000;
      if (major === 5) return minor === 0 ? 0x4000 : 0x8000;
      return major >= 6 ? 0x8000 : 0xf000;
    default:
      return 0xf000;
  }
}

/** 004228A0 uses cleared name buffers, fresh GetVersionExA, and CPUID.1 EAX low12. */
export function legacy169SystemIdentity(
  cpu: BurikoCpuProfile,
  system: BurikoSystemProfile,
  seed: number,
): number {
  const first = (bytes: Uint8Array | null, capacity: number): number => {
    if (bytes === null || bytes.length >= capacity) return 0;
    if (bytes.includes(0))
      throw new RangeError('Buriko system host returned a terminated ANSI profile field');
    return bytes[0] ?? 0;
  };
  const user = first(system.host.readUserName(), 256);
  const computer = first(system.host.readComputerName(), 16);
  const version = system.host.readVersion();
  if (version === null)
    throw new Error('Buriko 1.69 identity consumes unwritten GetVersionExA output');
  const registers = cpu.query(1);
  if (registers === null)
    throw new Error('Buriko 1.69 identity consumes an indeterminate CPUID result');
  return (
    (((((registers[0] & 0xfff) | osClass(version)) << 16) | (user << 8) | computer) ^ seed) >>> 0
  );
}

const mapped = (status: number): number => {
  switch (status >>> 0) {
    case 0:
      return 0;
    case 0x80000001:
      return 1;
    case 0x80000002:
      return 2;
    case 0x80000004:
      return 4;
    default:
      return status;
  }
};

export function createLegacy169NativeDefinitions(
  cpu: BurikoCpuProfile,
  system: BurikoSystemProfile,
  flash: BurikoLegacy169FlashSurfaces,
): BurikoNativeSlotDefinition[] {
  return [
    {
      primary: 0x80,
      secondary: 0xef,
      nativeAddress: 0x00461d30,
      name: 'LegacySystemIdentity',
      execute: (h) => {
        push32(h.thread, legacy169SystemIdentity(cpu, system, pop32(h.thread)));
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0xf4,
      nativeAddress: 0x0045d240,
      name: 'CreateFlashSurface',
      execute: async (h): Promise<0> => {
        const option = pop32(h.thread),
          name = h.memory.resolve(h.thread, pop32(h.thread));
        const height = pop32(h.thread),
          width = pop32(h.thread),
          slot = pop32(h.thread);
        if (name === null) throw new Error('Buriko Flash creation consumes a null filename');
        push32(h.thread, mapped(await flash.create(slot, width, height, name, option)));
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0xf5,
      nativeAddress: 0x0045d2f0,
      name: 'StartFlashSurface',
      execute: async (h): Promise<0> => {
        push32(h.thread, mapped(await flash.start(pop32(h.thread))));
        return 0;
      },
    },
    {
      primary: 0x91,
      secondary: 0xf6,
      nativeAddress: 0x0045d370,
      name: 'DetachFlashSurface',
      execute: async (h): Promise<0> => {
        const status = await flash.detach(pop32(h.thread));
        push32(h.thread, status === 0x80000001 ? 1 : status === 0x80000004 ? 4 : status);
        return 0;
      },
    },
  ];
}

/** 00452100 has no secondary word and pushes no result, including failure paths. */
export function createLegacy169PrimaryOpcodes(
  surfaces: BurikoSurfaces,
): Readonly<Record<number, BurikoBpOpcodeHandler>> {
  return {
    0x7f: (h) => {
      const sourceIndex = pop32(h.thread),
        destinationIndex = pop32(h.thread);
      const source = surfaces.snapshot(sourceIndex);
      if (source === null) return 0;
      if (
        surfaces.allocate(
          destinationIndex,
          (source.width + 1) >>> 1,
          (source.height + 1) >>> 1,
          source.format,
        ) === 0
      )
        return 0;
      reduceLegacy169BitmapHalf(surfaces.snapshot(destinationIndex)!, source);
      return 0;
    },
  };
}
