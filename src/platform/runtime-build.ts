// Supplied by the player bundler. Direct runtime modules and Node tools have no build stamp.
declare const __VN_RUNTIME_BUILD_ID__: string;

/** Build-owned metadata only; never includes local paths or game identifiers. */
export const RUNTIME_BUILD_ID: string | null =
  typeof __VN_RUNTIME_BUILD_ID__ === 'string' ? __VN_RUNTIME_BUILD_ID__ : null;
