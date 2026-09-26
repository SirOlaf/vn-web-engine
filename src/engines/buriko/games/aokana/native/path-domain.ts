/** Selected ordinary DOS/UNC namespace. Unsupported Win32 normalization is a composition gap. */
export function assertAokanaPathDomain(value: string, search = false): void {
  const path = value.replaceAll('/', '\\');
  const unsupported = (): never => {
    throw new Error('Aokana mounted path profile does not support this Windows path form');
  };
  if (path.startsWith('\\\\?\\') || path.startsWith('\\\\.\\')) unsupported();
  const body = /^[a-z]:/i.test(path) ? path.slice(2) : path;
  if (body.includes(':')) unsupported();
  const parts = body.split('\\');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part === '' || part === '.' || part === '..') continue;
    const wildcard = search && i === parts.length - 1 && /[*?]/.test(part);
    if (/[<>"|\x00-\x1f]/.test(part) || (!wildcard && /[*?]/.test(part))) unsupported();
    if (/ $/.test(part) || (!wildcard && /\.$/.test(part))) unsupported();
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part)) unsupported();
  }
}
