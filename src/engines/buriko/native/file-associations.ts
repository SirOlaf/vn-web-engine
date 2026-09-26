import type {BurikoBpPointer} from '../bp/memory.js';
import {textBytes} from './text.js';
import {BurikoNativeText} from './text.js';
import type {
  WindowsAssociationKey,
  WindowsFileAssociationHost,
} from '../../../platform/windows-file-associations.js';

const HKCR = 0x80000000;
const KEY_ACCESS = 0x20006;

function snapshot(pointer: BurikoBpPointer): Uint8Array {
  return textBytes(pointer, true).slice();
}

function wideString(value: string): Uint8Array {
  const bytes = new Uint8Array((value.length + 1) * 2),
    view = new DataView(bytes.buffer);
  for (let index = 0; index < value.length; index++)
    view.setUint16(index * 2, value.charCodeAt(index), true);
  return bytes;
}

/** C6D10's sequential HKCR registration and successful-tail global notifications. */
export class BurikoFileAssociations {
  constructor(
    readonly host: WindowsFileAssociationHost,
    readonly text: BurikoNativeText,
  ) {}

  private decode(bytes: Uint8Array): string {
    return this.text.decodeAuto({bytes, offset: 0});
  }

  private async create(
    root: number | WindowsAssociationKey,
    subkey: string,
  ): Promise<WindowsAssociationKey | null> {
    const result = await this.host.createKey(root, subkey, KEY_ACCESS);
    if (result.result !== 0) return null;
    if (result.handle === undefined)
      throw new Error('Buriko file association host returned success without a registry handle');
    return result.handle;
  }

  private async setDefault(key: WindowsAssociationKey, value: string): Promise<boolean> {
    return (await this.host.setValue(key, null, 1, wideString(value))) === 0;
  }

  async register(
    extension: BurikoBpPointer,
    className: BurikoBpPointer,
    description: BurikoBpPointer,
    icon: BurikoBpPointer,
    command: BurikoBpPointer,
  ): Promise<0 | 1> {
    // Host operations await, so keep the caller's five native strings stable for this call.
    const source = [extension, className, description, icon, command].map(snapshot);
    const extensionKey = await this.create(HKCR, `.${this.decode(source[0]!)}`);
    if (extensionKey === null || !(await this.setDefault(extensionKey, this.decode(source[1]!))))
      return 0;

    const classKey = await this.create(HKCR, this.decode(source[1]!));
    if (classKey === null || !(await this.setDefault(classKey, this.decode(source[2]!)))) return 0;

    const iconKey = await this.create(classKey, 'DefaultIcon');
    if (iconKey === null || !(await this.setDefault(iconKey, this.decode(source[3]!)))) return 0;

    const shellKey = await this.create(classKey, 'Shell');
    if (shellKey === null) return 0;
    const openKey = await this.create(shellKey, 'Open');
    if (openKey === null) return 0;
    const commandKey = await this.create(openKey, 'Command');
    if (commandKey === null || !(await this.setDefault(commandKey, this.decode(source[4]!))))
      return 0;

    // The native function ignores these two external notification results.
    await this.host.postMessageA(0xffff, 0x1a, 0x2e, 0);
    await this.host.shellChangeNotify(0x08000000, 0x3000, null, null);
    return 1;
  }
}
