export interface TouchMousePoint {
  x: number;
  y: number;
  inside: boolean;
}
export interface TouchMouseFrame extends TouchMousePoint {
  buttons: number;
  pressedButtons: number;
}
interface Contact {
  id: number;
  anchor: TouchMousePoint;
  point: TouchMousePoint;
  client: {x: number; y: number};
  since: number;
  mode: 'pending' | 'drag' | 'secondary';
}

/** Host touch-to-mouse gestures, independent of game actions and native click rules.
 * Tap: left click. Move >8 CSS px: left drag. Hold still 500 ms or add a second finger: one right click.
 * Button transitions survive between samples; moves coalesce after the press anchor.
 */
export class TouchMouse {
  private contact: Contact | undefined;
  private fingers = new Set<number>();
  private current: TouchMouseFrame = {x: 0, y: 0, inside: false, buttons: 0, pressedButtons: 0};
  private pending: TouchMouseFrame[] = [];
  constructor(private readonly now: () => number = () => performance.now()) {}
  get active(): boolean {
    return this.fingers.size !== 0;
  }
  owns(id: number): boolean {
    return this.contact?.id === id && this.fingers.has(id);
  }
  down(
    id: number,
    primary: boolean,
    point: TouchMousePoint,
    client = {x: point.x, y: point.y},
  ): boolean {
    if (!point.inside || this.fingers.has(id)) return false;
    if (this.active) {
      if (primary) return false;
      this.fingers.add(id);
      // Never convert an already-started drag or repeat an emitted right click.
      if (this.contact?.mode === 'pending') this.secondaryClick();
      return true;
    }
    if (!primary) return false;
    this.fingers.add(id);
    this.contact = {id, anchor: point, point, client, since: this.now(), mode: 'pending'};
    this.push({...point, buttons: 0, pressedButtons: 0});
    return true;
  }
  move(id: number, point: TouchMousePoint, client = {x: point.x, y: point.y}): void {
    if (!this.owns(id)) return;
    const contact = this.contact!;
    contact.point = point;
    if (
      contact.mode === 'pending' &&
      Math.hypot(client.x - contact.client.x, client.y - contact.client.y) > 8
    ) {
      contact.mode = 'drag';
      this.push({...contact.anchor, buttons: 1, pressedButtons: 1});
    }
    if (contact.mode === 'drag') this.push({...point, buttons: 1, pressedButtons: 0});
  }
  up(id: number, point: TouchMousePoint, client = {x: point.x, y: point.y}): void {
    if (!this.fingers.has(id)) return;
    if (!this.owns(id)) {
      this.fingers.delete(id);
      if (!this.active) this.contact = undefined;
      return;
    }
    // A final displaced release is a drag even if the browser coalesced all moves.
    this.move(id, point, client);
    this.longPress();
    const contact = this.contact!;
    if (contact.mode === 'pending' && point.inside) {
      this.push({...contact.anchor, buttons: 1, pressedButtons: 1});
      this.push({...point, buttons: 0, pressedButtons: 0});
    } else if (contact.mode === 'drag') this.push({...point, buttons: 0, pressedButtons: 0});
    // Keep the gesture consumed until every accepted finger has lifted.
    contact.mode = 'secondary';
    this.fingers.delete(id);
    if (!this.active) this.contact = undefined;
  }
  cancel(id: number): void {
    if (this.fingers.has(id)) this.clear();
  }
  clear(): void {
    this.fingers.clear();
    this.contact = undefined;
    this.pending = [];
    this.current = {...this.current, inside: false, buttons: 0, pressedButtons: 0};
  }
  sample(): TouchMouseFrame {
    this.longPress();
    const next = this.pending.shift();
    if (next) this.current = next;
    const result = {...this.current};
    this.current = {...this.current, pressedButtons: 0};
    return result;
  }
  private longPress(): void {
    const c = this.contact;
    if (!c || c.mode !== 'pending' || !c.point.inside || this.now() - c.since < 500) return;
    this.secondaryClick();
  }
  private secondaryClick(): void {
    const c = this.contact!;
    c.mode = 'secondary';
    this.push({...c.point, buttons: 2, pressedButtons: 2});
    this.push({...c.point, buttons: 0, pressedButtons: 0});
  }
  private push(frame: TouchMouseFrame): void {
    const last = this.pending.at(-1);
    if (last && last.buttons === frame.buttons && !last.pressedButtons && !frame.pressedButtons)
      this.pending[this.pending.length - 1] = frame;
    else this.pending.push(frame);
  }
}
