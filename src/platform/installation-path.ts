/** Host filesystem sidecars are not part of the installed Windows game. */
export function isInstallationMetadata(path: string): boolean {
  return path.split('/').some((name) => name.startsWith('._') || name === '.DS_Store');
}
