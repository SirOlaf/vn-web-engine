/** The browser host chooses a Win32-shaped temporary name; the selected mounted
 * store remains responsible for checking, creating and deleting actual bytes. */
export interface WindowsTemporaryFileOperations {
  /** Null means the mounted namespace could not answer, rather than absent. */
  exists(path: string): Promise<boolean | null>;
  create(path: string): Promise<boolean>;
  remove(path: string): Promise<boolean>;
}

export class BrowserWindowsTemporaryFileHost {
  constructor(private readonly random: Pick<Crypto, 'getRandomValues'> | null) {}

  async createTemporaryFile(
    operations: WindowsTemporaryFileOperations,
    directory: string,
    prefix: string,
  ): Promise<string | null> {
    // GetTempFileNameW uses up to the first three UTF-16 characters, stopping at NUL.
    prefix = prefix.split('\0', 1)[0]!.slice(0, 3);
    if (this.random === null) return null;
    const seed = this.random.getRandomValues(new Uint16Array(1))[0]!;
    for (let offset = 0; offset < 0x10000; offset++) {
      const suffix = ((seed + offset) & 0xffff).toString(16).toUpperCase().padStart(4, '0');
      const path = directory + (directory.endsWith('\\') ? '' : '\\') + prefix + suffix + '.TMP';
      const exists = await operations.exists(path);
      if (exists === null) return null;
      if (exists) continue;
      return (await operations.create(path)) ? path : null;
    }
    return null;
  }

  async deleteTemporaryFile(
    operations: WindowsTemporaryFileOperations,
    path: string,
  ): Promise<number> {
    return Number(await operations.remove(path));
  }
}
