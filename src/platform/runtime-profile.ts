/** Shared runtime policy; engines decide where each profile affects scheduling. */
export type RuntimeProfile = 'native' | 'browser-optimized';

let profile: RuntimeProfile = 'browser-optimized';
const listeners = new Set<(profile: RuntimeProfile) => void>();

export function getRuntimeProfile(): RuntimeProfile {
  return profile;
}

/** Applies to subsequent work; an engine may retain its current pass's policy. */
export function setRuntimeProfile(value: RuntimeProfile): void {
  if (value !== 'native' && value !== 'browser-optimized')
    throw new TypeError('Invalid runtime profile');
  if (value === profile) return;
  profile = value;
  for (const listener of listeners) {
    try {
      listener(value);
    } catch {
      /* A policy observer must not prevent other observers from updating. */
    }
  }
}

/** Immediately reports the selected profile, then subsequent changes. */
export function subscribeRuntimeProfile(listener: (profile: RuntimeProfile) => void): () => void {
  listeners.add(listener);
  try {
    listener(profile);
  } catch {
    /* A policy observer must not interrupt runtime setup. */
  }
  return () => listeners.delete(listener);
}
