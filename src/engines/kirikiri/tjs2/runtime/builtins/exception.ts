/** The `Exception` class (krkrz `tjsException.cpp`): `message` and `trace` members. */
import {TJS_MEMBERENSURE, TJS_S_OK} from '../interface.js';
import {NativeClass, paramExists} from '../native.js';
import {EMPTY_STRING} from '../variant.js';

export class ExceptionClass extends NativeClass {
  constructor() {
    super('Exception');
    this.emptyFinalize();
    this.constructorMethod((_result, args, objthis) => {
      const o = objthis!;
      o.propSet(TJS_MEMBERENSURE, 'message', paramExists(args, 0) ? args[0]! : EMPTY_STRING, o);
      o.propSet(TJS_MEMBERENSURE, 'trace', paramExists(args, 1) ? args[1]! : EMPTY_STRING, o);
      return TJS_S_OK;
    });
  }
}
