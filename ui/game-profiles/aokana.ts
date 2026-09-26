/** Compatibility with the first player's persistent browser data. This exact
 * executable profile is deliberately separate from the BGI engine. */
export const legacyAokanaProfile = {
  executableSha256: 'f585e28f79923b8aa487d8690165e45ce3377c7e1b8381d3b75c659c7e933d7a',
  productIdentity: 'AoNoKanataNoFourRhythmUEDL',
  id: 'legacy-aokana',
  title: 'Aokana',
  legacyRoute: './aokana.html',
  namespace: ['aokana', 'default'],
} as const;

export function legacyAokanaRoute(pathname: string): boolean {
  return pathname.toLowerCase().endsWith('/aokana.html');
}
