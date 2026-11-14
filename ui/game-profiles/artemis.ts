/** Browser compatibility policy, separate from native revision and filesystem behavior.
 * Match both the executable and original module bytes before substituting a Lua entry.
 * The installation, raw Lua file API, file CRC and save namespace remain unchanged. */
export interface ArtemisLuaCompatibilityRule {
  readonly executableSha256: string;
  readonly path: string;
  readonly sourceSha256: string;
  readonly begin: string;
  readonly end: string;
  readonly replacement: string;
}
const rules: readonly ArtemisLuaCompatibilityRule[] = [
  {
    executableSha256: '38feda70823430350ae58086225ac4a983ab727bd68b4800c4bbeed285ea0123',
    path: 'system/dmmck.lua',
    sourceSha256: '4cbcb35a5c6a1a11fd691c14ad78192b08795bbec54e4f3c960d5734aa06c985',
    begin: 'function init_dmmck()',
    end: 'function dmmck_login(',
    replacement: 'function init_dmmck()\nend\n',
  },
  {
    executableSha256: 'e551146298aa98987b5965964610c909ae8f2c06ab3ac536a733b4bc1e9bbcde',
    path: 'system/extend/auth.lua',
    sourceSha256: '9228205bddae0aee8e3d70f31426367a264ea314c5ae6edc0dfbad796e6985eb',
    begin: 'function authentication()',
    end: 'function authenticationchange(',
    replacement: 'function authentication()\nend\n',
  },
  {
    executableSha256: '116507c5967b82f7816b69aeeb1553b47f2bfd2b91aac6dc02eb9371497d0c66',
    path: 'system/extend/auth.lua',
    sourceSha256: '6827a099a8033d9ff9a9c1399fa25783592138af0d16341ed55126cbaf9cdea7',
    begin: 'function authentication()',
    end: 'function authenticationchange(',
    replacement: 'function authentication()\nend\n',
  },
];

/** Policy-driven source substitutions used only by the Lua compiler/include owner.
 * Absent or different modules pass through, including installations already without a gate. */
export async function prepareArtemisLuaCompatibility(
  executableSha256: string,
  read: (path: string) => Promise<Uint8Array | null>,
  policy: readonly ArtemisLuaCompatibilityRule[] = rules,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const sources = new Map<string, Uint8Array>();
  for (const rule of policy) {
    if (rule.executableSha256 !== executableSha256) continue;
    const original = await read(rule.path);
    if (original === null) continue;
    const digest = await crypto.subtle.digest('SHA-256', original.slice().buffer);
    const sha256 = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
    if (sha256 !== rule.sourceSha256) continue;
    const text = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(original);
    const start = text.indexOf(rule.begin),
      end = text.indexOf(rule.end, start + rule.begin.length);
    if (start < 0 || end < 0) throw Error('Invalid verified Artemis compatibility module');
    const removedLines = text.slice(start, end).split('\n').length - 1;
    const replacementLines = rule.replacement.split('\n').length - 1;
    if (replacementLines > removedLines) throw Error('Invalid Artemis compatibility line count');
    const replacement = rule.replacement + '\n'.repeat(removedLines - replacementLines);
    sources.set(
      rule.path,
      new TextEncoder().encode(text.slice(0, start) + replacement + text.slice(end)),
    );
  }
  return sources;
}
