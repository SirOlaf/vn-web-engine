/** Native CFileName stem/extension, followed by exact lowercase _a substitution. */
export function artemisPairedSoundPath(path: string): string | null {
  const basenameStart = path.lastIndexOf('\\') + 1,
    dot = path.lastIndexOf('.'),
    extensionAt = dot >= basenameStart ? dot : path.length,
    stem = path.slice(0, extensionAt),
    extension = extensionAt < path.length ? path.slice(extensionAt + 1) : '';
  return stem.endsWith('_a') ? `${stem.slice(0, -2)}_b.${extension}` : null;
}
