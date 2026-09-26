import {AokanaDisplayObject, type AokanaDisplayObjectEnvironment} from './display-object.js';

/** 05BE50 / vtable 17D070: category-nine group, with the complete base virtual behavior. */
export class AokanaDisplayGroup extends AokanaDisplayObject {
  constructor(environment: AokanaDisplayObjectEnvironment, order: number) {
    super(environment, 9, order, 1);
  }
}
