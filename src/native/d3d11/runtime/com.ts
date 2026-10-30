import type {D3d11Result, ID3D11Device, ID3D11DeviceChild, IUnknown} from '../contract.js';

const IID_IUNKNOWN = '00000000-0000-0000-c000-000000000046';
const E_NOINTERFACE = 0x80004002 | 0;

/** Device storage stays alive while any caller owns an interface, independently of bindings. */
export class D3d11Lifetime {
  private externalReferences = 0;
  private readonly roots = new Set<() => void>();
  closed = false;

  constructor(private readonly disposeBindings: () => void) {}

  acquireExternal(): void {
    if (this.closed) throw new Error('D3D11 device lifetime has ended');
    this.externalReferences++;
  }

  releaseExternal(): void {
    if (this.externalReferences === 0) throw new Error('Unbalanced D3D11 interface release');
    if (--this.externalReferences !== 0) return;
    this.closed = true;
    // Bound objects can refer back to their device. They are internal references,
    // not caller roots; release them before retiring the device/context wrappers.
    const errors: unknown[] = [];
    try {
      this.disposeBindings();
    } catch (error) {
      errors.push(error);
    }
    for (const dispose of this.roots) {
      try {
        dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.roots.clear();
    if (errors.length !== 0) throw new AggregateError(errors, 'D3D11 resource disposal failed');
  }

  /** Device and immediate-context storage belongs to this lifetime, even at public count zero. */
  registerRoot(dispose: () => void): void {
    if (this.closed) throw new Error('D3D11 device lifetime has ended');
    this.roots.add(dispose);
  }
}

/** Private implementation handle. Public clients reach only its IUnknown interface. */
export class D3d11Object implements IUnknown {
  private externalReferences = 1;
  private internalReferences = 0;
  private destroyed = false;
  private readonly interfaces: ReadonlySet<string>;

  constructor(
    readonly lifetime: D3d11Lifetime,
    interfaces: readonly string[],
    private readonly dispose: () => void,
    /** Device/context wrappers can be reacquired from another live child interface. */
    private readonly root = false,
  ) {
    this.interfaces = new Set([IID_IUNKNOWN, ...interfaces.map((iid) => iid.toLowerCase())]);
    lifetime.acquireExternal();
    if (root) lifetime.registerRoot(() => this.destroy());
  }

  queryInterface(iid: string): D3d11Result<IUnknown> {
    if (!this.supportsInterface(iid)) return {hr: E_NOINTERFACE, value: null};
    this.addRef();
    return {hr: 0, value: this};
  }

  /** Internal identity check without borrowing an extra public reference. */
  supportsInterface(iid: string): boolean {
    return this.live && this.interfaces.has(iid.toLowerCase());
  }

  /** Internal validity check; released interfaces are never accepted by device factories. */
  get live(): boolean {
    return !this.destroyed && !this.lifetime.closed;
  }

  addRef(): number {
    if (this.destroyed || this.lifetime.closed) return 0;
    this.lifetime.acquireExternal();
    return ++this.externalReferences + this.internalReferences;
  }

  release(): number {
    if (this.externalReferences === 0) return this.internalReferences;
    this.externalReferences--;
    try {
      this.retire();
    } finally {
      this.lifetime.releaseExternal();
    }
    return this.externalReferences + this.internalReferences;
  }

  /** Pipeline bindings own references without keeping a device/binding cycle alive. */
  retainBinding(): void {
    if (this.destroyed || this.lifetime.closed) throw new Error('Binding a released D3D11 object');
    this.internalReferences++;
  }

  releaseBinding(): void {
    if (this.internalReferences === 0) throw new Error('Unbalanced D3D11 binding release');
    this.internalReferences--;
    this.retire();
  }

  private retire(): void {
    if (!this.root && this.externalReferences + this.internalReferences === 0) this.destroy();
  }

  private destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.dispose();
  }
}

export interface D3d11DeviceOwner {
  readonly lifetime: D3d11Lifetime;
  readonly device: ID3D11Device;
}

/** Shared implementation of the inherited native device-child interface. */
export class D3d11ChildObject extends D3d11Object implements ID3D11DeviceChild {
  constructor(
    private readonly deviceOwner: D3d11DeviceOwner,
    interfaces: readonly string[],
    dispose: () => void,
    root = false,
  ) {
    super(
      deviceOwner.lifetime,
      ['1841e5c8-16b0-489b-bcc8-44cfb0d5deae', ...interfaces],
      dispose,
      root,
    );
  }
  getDevice(): ID3D11Device {
    if (!this.live) throw new Error('Using a released D3D11 device child');
    this.deviceOwner.device.addRef();
    return this.deviceOwner.device;
  }
}
