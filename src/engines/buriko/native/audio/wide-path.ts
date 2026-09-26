export const audioPathSeparator = (unit: number): boolean => unit === 47 || unit === 92;
export const audioPathDrive = (path: string): boolean =>
  path.length >= 2 && path.charCodeAt(1) === 58 && ((path.charCodeAt(0) & ~32) - 65) >>> 0 < 26;
export const audioPathTerminated = (value: string): string => {
  const end = value.indexOf('\0');
  return end < 0 ? value : value.slice(0, end);
};
/** 00F510 returns the root-name end index, not a generic absolute-path predicate. */
export function audioRootNameEnd(path: string): number {
  const length = path.length;
  if (length < 2) return 0;
  if (audioPathDrive(path)) return 2;
  if (!audioPathSeparator(path.charCodeAt(0))) return 0;
  const second = path.charCodeAt(1),
    third = path.charCodeAt(2);
  if (
    length >= 4 &&
    audioPathSeparator(path.charCodeAt(3)) &&
    (length === 4 || !audioPathSeparator(path.charCodeAt(4))) &&
    ((audioPathSeparator(second) && (third === 63 || third === 46)) ||
      (second === 63 && third === 63))
  )
    return 3;
  if (length >= 3 && audioPathSeparator(second) && !audioPathSeparator(third)) {
    let end = 3;
    while (end < length && !audioPathSeparator(path.charCodeAt(end))) end++;
    return end;
  }
  return 0;
}
/** 00F620: the native filesystem absolute test includes root-name-only paths. */
export function audioPathAbsolute(path: string): boolean {
  return audioPathDrive(path)
    ? path.length > 2 && audioPathSeparator(path.charCodeAt(2))
    : audioRootNameEnd(path) !== 0;
}

/** 00ED20: filesystem path append, preserving literal spelling and root-name comparison. */
export function appendAudioWidePath(left: string, right: string): string {
  if (audioPathAbsolute(right)) return right;
  const leftRoot = audioRootNameEnd(left),
    rightRoot = audioRootNameEnd(right);
  if (rightRoot !== 0 && left.slice(0, leftRoot) !== right.slice(0, rightRoot)) return right;
  if (rightRoot < right.length && audioPathSeparator(right.charCodeAt(rightRoot))) {
    left = left.slice(0, leftRoot);
  } else if (leftRoot === left.length) {
    if (leftRoot >= 3) left += '\\';
  } else if (!audioPathSeparator(left.charCodeAt(left.length - 1))) {
    left += '\\';
  }
  return left + right.slice(rightRoot);
}
