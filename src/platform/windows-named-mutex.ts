/** Browser CreateMutexA cannot establish a named kernel object across processes. */
export class BrowserWindowsNamedMutexHost {
  createOwned(_name: unknown): null {
    return null;
  }
  release(_handle: unknown): void {}
  close(_handle: unknown): void {}
}

export const ERROR_ALREADY_EXISTS = 183;

/**
 * Named mutexes of one page, the kernel namespace a single game instance sees. `create` is
 * `CreateMutexW` with its `GetLastError`: `ERROR_ALREADY_EXISTS` when the name is open in the
 * page, else 0. Other tabs and processes are not visible. A mutex lives until every handle to
 * it is closed; handles of a page close with the page.
 */
export class PageWindowsNamedMutexes {
  readonly #open = new Map<string, number>();

  create(name: string): {handle: {name: string}; lastError: number} {
    const count = this.#open.get(name) ?? 0;
    this.#open.set(name, count + 1);
    return {handle: {name}, lastError: count ? ERROR_ALREADY_EXISTS : 0};
  }

  close(handle: {name: string}): void {
    const count = this.#open.get(handle.name) ?? 0;
    if (count <= 1) this.#open.delete(handle.name);
    else this.#open.set(handle.name, count - 1);
  }
}
