import type {WindowsPathOptions} from './windows-filesystem.js';

/** Explicit guest volumes. Preserve drive and every directory in persistent storage.
 * Host paths and host environment variables never participate in resolution. */
export function windowsLayout(
  installation: string,
  drives: readonly string[] = ['C:'],
): WindowsPathOptions {
  if (!/^[a-z]:\\/i.test(installation))
    throw new Error('Installation requires an absolute guest drive path');
  const roots = drives.map((d) => {
    if (!/^[a-z]:$/i.test(d)) throw new Error(`Invalid guest drive: ${d}`);
    return d.toUpperCase();
  });
  if (
    new Set(roots).size !== roots.length ||
    !roots.includes(installation.slice(0, 2).toUpperCase())
  )
    throw new Error('Duplicate or missing installation drive');
  return {
    cwd: installation,
    mounts: [
      ...roots.map((d) => ({windows: d + '\\', virtual: '/user/drives/' + d[0]})),
      {windows: installation, virtual: '/game'},
    ],
    driveDirectories: Object.fromEntries(roots.map((d) => [d, d + '\\'])),
  };
}
