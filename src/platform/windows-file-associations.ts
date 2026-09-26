/** Opaque registry-key identity supplied by a selected Windows-shaped host. */
export type WindowsAssociationKey = object;
export type WindowsAssociationRoot = number | bigint | WindowsAssociationKey;

type HostResult<T> = T | Promise<T>;

/** Win32 registry and shell notifications used by the Buriko file-association procedure. */
export interface WindowsFileAssociationHost {
  createKey(
    root: WindowsAssociationRoot,
    subkey: string,
    access: number,
  ): HostResult<{readonly result: number; readonly handle?: WindowsAssociationKey}>;
  setValue(
    key: WindowsAssociationKey,
    name: string | null,
    type: number,
    data: Uint8Array,
  ): HostResult<number>;
  postMessageA(window: number, message: number, wParam: number, lParam: number): HostResult<number>;
  shellChangeNotify(event: number, flags: number, item1: null, item2: null): HostResult<void>;
}

interface BrowserKey extends WindowsAssociationKey {
  readonly path: string;
}

/**
 * Browser profile for file associations. It keeps a process-local HKCR-shaped table so the
 * application can observe its own registration, and records the two notifications for the
 * browser host to surface. It never accesses the machine registry or broadcasts to the OS.
 */
export class BrowserWindowsFileAssociationHost implements WindowsFileAssociationHost {
  private readonly handles = new WeakMap<WindowsAssociationKey, string>();
  private readonly keys = new Set<string>();
  private readonly values = new Map<string, {readonly type: number; readonly data: Uint8Array}>();
  private readonly notificationLog: Array<
    | {
        readonly kind: 'setting-change';
        readonly window: number;
        readonly message: number;
        readonly wParam: number;
        readonly lParam: number;
      }
    | {readonly kind: 'shell-change'; readonly event: number; readonly flags: number}
  > = [];

  get notifications(): readonly (typeof this.notificationLog)[number][] {
    return this.notificationLog;
  }

  value(path: string): {readonly type: number; readonly data: Uint8Array} | undefined {
    const entry = this.values.get(this.valueKey(path));
    return entry === undefined ? undefined : {type: entry.type, data: entry.data.slice()};
  }

  private keyPath(root: WindowsAssociationRoot): string | null {
    if (typeof root === 'number' || typeof root === 'bigint') {
      const value = BigInt.asUintN(64, BigInt(root));
      return value === 0x80000000n || value === 0xffffffff80000000n ? '' : null;
    }
    return this.handles.get(root) ?? null;
  }

  private valueKey(path: string): string {
    return path
      .replace(/\\+/g, '\\')
      .replace(/^\\|\\$/g, '')
      .toLowerCase();
  }

  createKey(
    root: WindowsAssociationRoot,
    subkey: string,
    access: number,
  ): {result: number; handle?: WindowsAssociationKey} {
    const parent = this.keyPath(root);
    if (parent === null) return {result: 6};
    if (access >>> 0 !== 0x20006 || subkey.startsWith('\\')) return {result: 87};
    const path = [parent, subkey].filter(Boolean).join('\\').replace(/\\+/g, '\\');
    if (path.includes('\0')) return {result: 123};
    const normalized = this.valueKey(path);
    let current = '';
    for (const component of path.split('\\')) {
      current = current ? `${current}\\${component}` : component;
      this.keys.add(this.valueKey(current));
    }
    const handle: BrowserKey = {path: normalized};
    this.handles.set(handle, normalized);
    return {result: 0, handle};
  }

  setValue(
    key: WindowsAssociationKey,
    name: string | null,
    type: number,
    data: Uint8Array,
  ): number {
    const path = this.handles.get(key);
    if (path === undefined) return 6;
    if (type !== 1 || (name !== null && name !== '')) return 87;
    this.values.set(this.valueKey(path), {type, data: data.slice()});
    return 0;
  }

  postMessageA(window: number, message: number, wParam: number, lParam: number): number {
    this.notificationLog.push({kind: 'setting-change', window, message, wParam, lParam});
    return 1;
  }

  shellChangeNotify(event: number, flags: number, item1: null, item2: null): void {
    if (item1 !== null || item2 !== null)
      throw new TypeError('Browser shell notification expects null items');
    this.notificationLog.push({kind: 'shell-change', event, flags});
  }
}
