/** The shipped executable never changes the CRT C locale (1401cfb94 stays zero).
 * _wcslwr (14001db94) and __ascii_wcsnicmp (14001c698) fold ASCII only. */
export function burikoCrtWideLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 32));
}

export function burikoCrtWidePrefixEqual(value: string, prefix: string): boolean {
  for (let index = 0; index < prefix.length; index++) {
    const a = value.charCodeAt(index) || 0;
    const b = prefix.charCodeAt(index);
    if ((a >= 65 && a <= 90 ? a + 32 : a) !== (b >= 65 && b <= 90 ? b + 32 : b)) return false;
    if (a === 0) return true;
  }
  return true;
}
