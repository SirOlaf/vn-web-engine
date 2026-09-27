import {getRuntimeProfile} from '../../../platform/runtime-profile.js';
import type {BurikoDisplayObjectEnvironment} from './display-object.js';

// Only synchronous control-process setter groups enter this scope. They do not
// mutate source pixels or yield to BP code; mixed pixels are ready before return.
const activeBatches = new WeakMap<BurikoDisplayObjectEnvironment, Map<object, () => void>>();

export function withBurikoDisplayUpdateBatch(
  environment: BurikoDisplayObjectEnvironment,
  operation: () => void,
): void {
  if (getRuntimeProfile() !== 'browser-optimized') {
    operation();
    return;
  }

  const existing = activeBatches.get(environment);
  if (existing !== undefined) {
    try {
      operation();
    } catch (error) {
      existing.clear();
      throw error;
    }
    return;
  }

  const queued = new Map<object, () => void>();
  activeBatches.set(environment, queued);
  try {
    operation();
  } catch (error) {
    queued.clear();
    activeBatches.delete(environment);
    throw error;
  }

  // Flush outside the active scope so callbacks cannot accidentally join it.
  activeBatches.delete(environment);
  try {
    while (queued.size !== 0) {
      const [owner, rebuild] = queued.entries().next().value as [object, () => void];
      queued.delete(owner);
      rebuild();
    }
  } finally {
    queued.clear();
  }
}

export function deferBurikoSpriteMix(
  environment: BurikoDisplayObjectEnvironment,
  owner: object,
  rebuild: () => void,
): boolean {
  const batch = activeBatches.get(environment);
  if (batch === undefined) return false;
  batch.set(owner, rebuild);
  return true;
}

export function cancelBurikoSpriteMix(
  environment: BurikoDisplayObjectEnvironment,
  owner: object,
): void {
  activeBatches.get(environment)?.delete(owner);
}
