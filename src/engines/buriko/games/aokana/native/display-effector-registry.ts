import type {AokanaDisplayObject} from './display-object.js';

/** CDspObjEffector +170, read nonvirtually by 05ae30. */
export type AokanaDisplayEffector = AokanaDisplayObject & {effectorMode: number};
interface EffectorLink {
  object: AokanaDisplayEffector;
  next: EffectorLink | null;
}

/** The independent linked roots at 1d1d38; the actual manager still owns the pool slots. */
export class AokanaDisplayEffectorRegistry {
  private first: EffectorLink | null = null;
  /** Constructor 05b9a0 prepends before resizing/configuring its newly constructed effector. */
  add(object: AokanaDisplayEffector): void {
    this.first = {object, next: this.first};
  }
  /** Destructor 05b920 removes the first pointer match before its base destructor. */
  remove(object: AokanaDisplayEffector): void {
    let previous: EffectorLink | null = null;
    for (let current = this.first; current !== null; current = current.next) {
      if (current.object === object) {
        if (previous === null) this.first = current.next;
        else previous.next = current.next;
        return;
      }
      previous = current;
    }
  }
  /** 05b8e0 stops at the first visible effector. */
  hasVisible(): boolean {
    for (let current = this.first; current !== null; current = current.next)
      if (current.object.inputActive() !== 0) return true;
    return false;
  }
  /** 05b890 permits visible mode4 and all-ones objects, and ignores hidden objects. */
  permitsDistributedDraw(): boolean {
    for (let current = this.first; current !== null; current = current.next) {
      const object = current.object;
      if (object.inputActive() !== 0) {
        const mode = object.effectorMode | 0;
        if (mode !== 4 && mode !== -1) return false;
      }
    }
    return true;
  }
}
