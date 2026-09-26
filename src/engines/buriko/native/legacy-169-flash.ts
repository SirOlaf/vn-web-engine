import type {
  WindowsFlashBitmap,
  WindowsFlashControl,
  WindowsFlashHost,
} from '../../../platform/windows-flash.js';
import type {BurikoBpPointer} from '../bp/memory.js';
import {BurikoBitmapStorage, type BurikoBitmap} from './bitmap.js';
import {copyBurikoBitmapRows} from './bitmap-copy.js';
import type {BurikoNativeNotifications} from './notification-queue.js';
import type {BurikoProgramFiles} from './program-files.js';
import type {BurikoSurfaces, BurikoSurfaceBitmapAttachment} from './surfaces.js';
import type {BurikoNativeText} from './text.js';
import {textBytes} from './text.js';
import type {BurikoSystemProfileHost} from './system-profile.js';

interface FlashEntry {
  readonly id: number;
  readonly slot: number;
  readonly path: string;
  readonly option: number;
  readonly control: WindowsFlashControl;
  readonly abort: AbortController;
  readonly pollInterval: number;
  lastPoll: number;
  attachment: BurikoSurfaceBitmapAttachment;
  status: number;
  totalFrames: number;
  lastFrame: number;
  completedLoops: number;
  active: boolean;
  bitmap: WindowsFlashBitmap | null;
  storage: BurikoBitmapStorage | null;
  serial: Promise<void>;
  retirement: Promise<void> | null;
}

/** 004069C0/00406A80/00406AF0 and CFlashDX's command worker. The registry is
 * separate from movies; a Flash surface lends its live DIB until detachment. */
export class BurikoLegacy169FlashSurfaces {
  private nextId = 0;
  private readonly entries = new Map<number, FlashEntry>();
  private readonly retirements = new Set<Promise<void>>();
  private readonly creations = new Set<Promise<number>>();
  private closed = false;

  constructor(
    readonly surfaces: BurikoSurfaces,
    readonly files: BurikoProgramFiles,
    readonly text: BurikoNativeText,
    readonly notifications: BurikoNativeNotifications,
    readonly host: WindowsFlashHost,
    readonly systemProfileHost: BurikoSystemProfileHost | null = null,
    private readonly now: () => number = () => performance.now(),
  ) {
    if (files.text !== text)
      throw new Error('Buriko Flash requires the selected native text owner');
  }

  private bitmap(entry: FlashEntry): BurikoBitmap | null {
    const bitmap = entry.control.bitmap();
    if (bitmap === null) return null;
    if (entry.bitmap?.bytes !== bitmap.bytes) {
      entry.storage?.release();
      // CreateDIBSection's initial pixel contents are unspecified. The host supplies
      // their observed bytes, and all later drawing mutates that same borrowed memory.
      entry.storage = new BurikoBitmapStorage(bitmap.bytes, true);
    }
    entry.bitmap = bitmap;
    return {
      storage: entry.storage,
      offset: bitmap.offset,
      stride: bitmap.stride,
      width: bitmap.width,
      height: bitmap.height,
      format: 1,
      bytesPerPixel: 4,
    };
  }

  private serial<T>(entry: FlashEntry, operation: () => Promise<T>): Promise<T> {
    const result = entry.serial.then(operation);
    entry.serial = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private retire(entry: FlashEntry): Promise<void> {
    if (entry.retirement !== null) return entry.retirement;
    entry.active = false;
    entry.abort.abort();
    if (this.entries.get(entry.slot) === entry) this.entries.delete(entry.slot);
    this.surfaces.detachBitmap(entry.slot, entry.attachment);
    const retirement = entry.serial.then(async () => {
      try {
        await entry.control.dispose();
      } finally {
        entry.storage?.release();
      }
    });
    entry.retirement = retirement;
    this.retirements.add(retirement);
    // Keep rejected retirements joinable instead of generating an unhandled rejection.
    void retirement.then(
      () => this.retirements.delete(retirement),
      () => undefined,
    );
    return retirement;
  }

  /** The native registry ID is consumed even when initialization has produced no DIB. */
  create(
    slot: number,
    width: number,
    height: number,
    name: BurikoBpPointer,
    option: number,
  ): Promise<number> {
    if (this.closed) throw new Error('Buriko Flash creation follows owner shutdown');
    // 00468260 converts the stored ANSI filename with CP_ACP (the selected
    // Japanese Windows profile), independently of the BP UTF-8 string mode.
    const result = this.createControl(
      slot,
      width,
      height,
      this.text.decodeCp932(textBytes(name)),
      option,
    );
    this.creations.add(result);
    void result.then(
      () => this.creations.delete(result),
      () => this.creations.delete(result),
    );
    return result;
  }

  private async createControl(
    slot: number,
    width: number,
    height: number,
    filename: string,
    option: number,
  ): Promise<number> {
    // 004684E0's zeroed GetVersionExA output selects a 1ms periodic waitable
    // timer on NT4+, otherwise MsgWaitForMultipleObjects times out at 100ms.
    const version = this.systemProfileHost?.readVersion();
    const pollInterval = version?.platform === 2 && version.major >>> 0 >= 4 ? 1 : 100;
    const created = await this.host.create(width | 0, height | 0);
    const id = this.nextId;
    this.nextId = (id + 1) | 0;
    if (created.control === null) return 0x80000001;
    if (this.closed) {
      await created.control.dispose();
      return 0x80000001;
    }
    const entry: FlashEntry = {
      id,
      slot: slot | 0,
      path:
        this.files.paths === null ? filename : this.files.paths.currentDirectory + '\\' + filename,
      option: option | 0,
      control: created.control,
      abort: new AbortController(),
      pollInterval,
      lastPoll: -Infinity,
      attachment: null!,
      status: created.status >>> 0,
      totalFrames: 0,
      lastFrame: -1,
      completedLoops: 0,
      active: true,
      bitmap: null,
      storage: null,
      serial: Promise.resolve(),
      retirement: null,
    };
    entry.attachment = {
      snapshot: () => {
        const borrowed = this.bitmap(entry),
          backing = this.surfaces.descriptor(entry.slot);
        return borrowed === null || backing === null
          ? null
          : {
              ...backing,
              storage: borrowed.storage,
              offset: borrowed.offset,
              stride: borrowed.stride,
            };
      },
      retire: () => {
        void this.retire(entry);
      },
    };
    if (this.bitmap(entry) === null) {
      await this.retire(entry);
      return 0x80000001;
    }
    if (this.surfaces.allocate(slot, width, height, 1) === 0) {
      await this.retire(entry);
      return 0x80000004;
    }
    this.entries.set(entry.slot, entry);
    this.surfaces.attachBitmap(slot, entry.attachment);
    return 0;
  }

  private lookup(slot: number): FlashEntry | number {
    if (this.surfaces.descriptor(slot) === null) return 0x80000004;
    return this.entries.get(slot | 0) ?? 0x80000001;
  }

  /** Worker command20: Movie, Loop=false, Play, TotalFrames, initial OleDraw retry. */
  async start(slot: number): Promise<number> {
    const entry = this.lookup(slot);
    if (typeof entry === 'number') return entry;
    const status = await this.serial(entry, async () => {
      if (!entry.active) return 0x80000001;
      if (entry.status !== 0) return entry.status;
      const control = entry.control;
      if ((await control.putMovie(entry.path)) !== 0) return 0x80000008;
      if (!entry.active) return 0x80000001;
      if ((await control.putLoop(false)) !== 0) return 0x80000007;
      if (!entry.active) return 0x80000001;
      if ((await control.play()) !== 0) return 0x80000009;
      if (!entry.active) return 0x80000001;
      const total = await control.totalFrames();
      if (total.hresult !== 0) return 0x80000007;
      entry.totalFrames = total.value | 0;
      while (entry.active) {
        try {
          if ((await control.draw(entry.abort.signal)) === 0) return entry.active ? 0 : 0x80000001;
          if (entry.active) await control.waitForDrawRetry(entry.abort.signal);
        } catch (error) {
          if (entry.active) throw error;
        }
      }
      return 0x80000001;
    });
    // The command worker stores its result before signalling the waiting caller.
    // A failed start therefore prevents detach from issuing another COM command.
    entry.status = status >>> 0;
    if (status === 0) return 0;
    await this.detach(slot);
    return status === 0x80000008 ? 0x80000002 : 0x80000001;
  }

  /** 00468440 detects frame changes, repeats manually, and counts end-frame arrivals. */
  private async update(entry: FlashEntry): Promise<void> {
    if (!entry.active) return;
    const current = await entry.control.frameNumber();
    if (current.hresult !== 0 || !entry.active) return;
    const frame = current.value | 0;
    if (frame !== entry.lastFrame) {
      entry.lastFrame = frame;
      if (frame === entry.totalFrames - 1) entry.completedLoops++;
    } else if (entry.option !== 0 && frame === entry.totalFrames - 1) {
      await entry.control.gotoFrame(0);
      await entry.control.play();
    } else return;
    if (entry.active) {
      try {
        if ((await entry.control.draw(entry.abort.signal)) === 0 && entry.active)
          this.notifications.push(0x10100, entry.slot, entry.id);
      } catch (error) {
        if (entry.active) throw error;
      }
    }
  }

  /** Sample each controller at its selected native timer interval, independent of VM opcodes. */
  async poll(): Promise<void> {
    if (this.closed) return;
    const now = this.now();
    // Native linked-list insertion visits the most recently created controller first.
    for (const entry of [...this.entries.values()].reverse()) {
      if (now - entry.lastPoll < entry.pollInterval) continue;
      entry.lastPoll = now;
      await this.serial(entry, () => this.update(entry));
    }
  }

  /** Command21 is GotoFrame(0), not StopPlay. Keep the slot's own backing after copy. */
  async detach(slot: number): Promise<number> {
    const entry = this.lookup(slot);
    if (typeof entry === 'number') return entry;
    let result: number;
    try {
      result = await this.serial(entry, async () => {
        if (!entry.active) return 0x80000001;
        if (entry.status === 0)
          entry.status = (await entry.control.gotoFrame(0)) === 0 ? 0 : 0x80000007;
        if (!entry.active) return 0x80000001;
        const source = this.bitmap(entry);
        if (source === null) return 0x80000001;
        const destination = this.surfaces.descriptor(slot);
        if (destination === null) return 0x80000004;
        copyBurikoBitmapRows(destination, source);
        return 0;
      });
    } finally {
      await this.retire(entry);
      const record = this.surfaces.record(slot);
      if (record !== null && !this.entries.has(slot | 0)) record.frame = -1;
    }
    return result;
  }

  async closeAndJoin(): Promise<void> {
    this.closed = true;
    const creations = await Promise.allSettled(this.creations);
    for (const entry of this.entries.values()) this.retire(entry);
    const results = await Promise.allSettled(this.retirements);
    this.retirements.clear();
    const failure = [...creations, ...results].find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
