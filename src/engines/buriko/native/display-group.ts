import {BurikoDisplayObject, type BurikoDisplayObjectEnvironment} from './display-object.js';

/** 05BE50 / vtable 17D070: category-nine group, with the complete base virtual behavior. */
export class BurikoDisplayGroup extends BurikoDisplayObject {
  constructor(environment: BurikoDisplayObjectEnvironment, order: number) {
    super(environment, 9, order, 1);
  }
}
