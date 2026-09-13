import {AOKANA_REGISTRY_UPPERCASE_PAIRS} from './registry-case-data.js';

export const AOKANA_REGISTRY_CASE_PROFILE = 'Unicode-15.1.0-BMP-simple-uppercase' as const;
const uppercase = new Uint16Array(0x10000);
for (let unit = 0; unit < uppercase.length; unit++) uppercase[unit] = unit;
for (let offset = 0; offset < AOKANA_REGISTRY_UPPERCASE_PAIRS.length; offset += 8) {
  const from = Number.parseInt(AOKANA_REGISTRY_UPPERCASE_PAIRS.slice(offset, offset + 4), 16);
  uppercase[from] = Number.parseInt(
    AOKANA_REGISTRY_UPPERCASE_PAIRS.slice(offset + 4, offset + 8),
    16,
  );
}

/** Explicit registry host profile: one uppercase mapping per UTF-16 unit, no expansion or normalization.
 * This versioned Unicode data is not claimed to equal every Windows NLS release. */
export function aokanaRegistryFold(name: string): string {
  let result = '';
  for (let index = 0; index < name.length; index++)
    result += String.fromCharCode(uppercase[name.charCodeAt(index)]!);
  return result;
}
