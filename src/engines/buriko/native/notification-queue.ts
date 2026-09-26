export interface BurikoNativeNotification {
  readonly type: number;
  readonly value1: number;
  readonly value2: number;
}
interface NotificationNode extends BurikoNativeNotification {
  next: NotificationNode | null;
}

/** 0fa3b0/0fa300/0fa2a0: native12-byte notifications in a separate FIFO from VM thread messages. */
export class BurikoNativeNotifications {
  private first: NotificationNode | null = null;
  private last: NotificationNode | null = null;
  push(type: number, value1: number, value2: number): void {
    const node: NotificationNode = {
      type: type >>> 0,
      value1: value1 >>> 0,
      value2: value2 >>> 0,
      next: null,
    };
    if (this.last === null) this.first = node;
    else this.last.next = node;
    this.last = node;
  }
  take(): BurikoNativeNotification | null {
    const node = this.first;
    if (node === null) return null;
    this.first = node.next;
    if (this.first === null) this.last = null;
    return {type: node.type, value1: node.value1, value2: node.value2};
  }
  clear(): void {
    this.first = this.last = null;
  }
}
