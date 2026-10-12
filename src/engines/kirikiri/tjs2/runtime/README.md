# TJS2 runtime

The TJS2 object model and built-in classes that the VM, the core's native classes and plugins
share. It follows krkrz `tjs2/` (`tjsVariant`, `tjsObject`, `tjsNative`, `tjsArray`,
`tjsDictionary`, `tjsMath`, …) and the reference build `nekopara_vol1.exe` where they differ.
There is no VM yet: `TjsEngine.executor` is where it plugs in.

| File               | Contents                                                                          |
| ------------------ | --------------------------------------------------------------------------------- |
| `interface.ts`     | Re-export of the TJS2 interface defined by `src/native/tvp-plugin/contract.ts`    |
| `variant.ts`       | Variant constructors, conversions, operators, number formatting                   |
| `slot.ts`          | `VariantSlot`: owning variant storage                                             |
| `errors.ts`        | `eTJS…` exceptions, `TJSThrowFrom_tjs_error`, the message table in use            |
| `dispatch.ts`      | `DispatchBase` (`tTJSDispatch`), the `TJSDefault…` member handlers, closure calls |
| `custom-object.ts` | `CustomObject` (`tTJSCustomObject`): member hash table, finalize, `missing`       |
| `native.ts`        | Native classes, methods, properties, functions; native instance IDs               |
| `suspension.ts`    | `Suspender`: suspending and resuming synchronous calls                            |
| `engine.ts`        | `TjsEngine` (`tTJS`): global object, built-in classes, host services, executor    |
| `msvc-sort.ts`     | `std::sort`/`std::stable_sort` of Visual C++ 2012/2013                            |
| `builtins/`        | `Array`, `Dictionary`, `Exception`, `Math`, `Math.RandomGenerator`                |

## Values

A `Variant` is an immutable tagged record: `{type: 0}` void, `{type: 1, object, objthis}` an
object closure, `{type: 2, value}` a string, `{type: 3, value}` an octet, `{type: 4, value}` a
64-bit integer as `bigint`, `{type: 5, value}` a double. The empty string and the empty octet
are the native null string and null octet. Integer and Real never mix: `int()`/`integer()`
and `real()` make them, `asInteger`/`asReal`/`asString`/`asBoolean` convert as `tTJSVariant`
does. The representation is explicit so that a Wasm VM can take the same values across its
boundary (`i64` crosses into JavaScript as `bigint`).

Behaviour of the reference build that the conversions reproduce:

- `(tTVInteger)real` truncates; NaN and out-of-range values give `INT64_MIN` (x86 conversion).
- Shifts use the low byte of the count; counts of 64 and above fill (the 32-bit `_allshl`
  helpers).
- `TJSRealToString` is `%.15lg` of the static pre-2015 CRT, with three exponent digits
  (`1e+020`); special values print as `NaN`, `+Infinity`, `-Infinity`, `+0.0`, `-0.0`.
- An object prints as `(object 0x…:0x…)`. Addresses are stable per-object counters.

## Objects

`Dispatch` is `iTJSDispatch2`: every method takes a call flag, a member name (`null` for the
object itself), out-parameters and the context `objthis`, and returns a result code
(`TJS_S_OK`, `TJS_E_MEMBERNOTFOUND`, …). Methods that address members by number call the
by-name method with the decimal name unless an object overrides them (arrays do).

**Reference counts.** Objects count references as natively, and the last `release` finalizes
(calls `finalize`, invalidates native instances, deletes members). The ownership rules are
the native ones:

- An object starts with one reference, owned by its creator. `createNew` hands that reference
  to the caller.
- Arguments are borrowed for the duration of a call.
- Results are written into caller-owned `VariantSlot`s, which take references; the caller
  clears or reuses the slot.
- Storage that outlives a call (members, array elements, native fields) holds references.
- A member or element holding a closure whose context is the object itself holds no
  reference on the object (`CheckObjectClosureAdd`), so bound methods do not keep their
  object alive.

**Member tables.** `CustomObject` ports the chained hash table of `tTJSCustomObject`:
one-at-a-time hash over UTF-16 code units, `2^bits` first-level entries (8 by default, 128 for
the global object), new members of a used bucket inserted after its head, enumeration per
bucket of the chain then the head, a lookup more than two links deep moving the entry to the
chain front, and `rebuildHash` sizing the table for a member count (`Dictionary.assign`,
`new Dictionary(n)`, `tjsDoRehash`). Enumeration order — and therefore `saveStruct` output
and `foreach` order — follows from it.

**Native classes.** `NativeClass` holds method and property objects. `new` creates the base
object, records the class name, registers the native instance (`createNativeInstance`),
copies non-static members with their context set to the new object, and calls the member
named after the class. `method`, `staticMethod`, `property`, `constructorMethod` declare
members as the `TJS_BEGIN_NATIVE_*` macros do; `constructNativeInstance` is the body of
`TJS_BEGIN_NATIVE_CONSTRUCTOR_DECL`.

## Suspension

Natively, storage reads, message boxes and modal windows block the calling script while the
core keeps running. Calls here are synchronous, and a call that has to wait returns
`TJS_E_SUSPENDED` instead:

1. The native that starts asynchronous work returns `suspender.suspend(promise, then)`.
   `then` finishes the call when the promise settles.
2. A caller that receives `TJS_E_SUSPENDED` and has work left registers it with
   `suspender.defer(resume)` and returns `TJS_E_SUSPENDED`. A caller whose call was its last
   action returns the code unchanged; results reach it through the slot it passed down.
   Callers that cannot continue later run their callees in `suspender.nonSuspending`, where
   a suspension is an error.
3. `suspender.run(start)` drives a top-level call (an event, the startup script). It awaits
   the pending promise and resumes the registered continuations innermost first. A
   continuation may suspend again; its new continuations run before the remaining outer
   ones.

`TJS_E_SUSPENDED` is a failure code, so code that knows nothing of suspension either passes it
on (`if (failed(hr)) return hr`) or throws on it. A suspension that is not passed up to `run`
is reported.

## Built-in classes

| Class                  | State                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `Array`                | complete except `pack` (OctPack) and binary `loadStruct`/`saveStruct`                 |
| `Dictionary`           | complete except `loadStruct` and binary `saveStruct`                                  |
| `Exception`            | complete                                                                              |
| `Math`                 | complete; `random` is `rand() / 32767.0` with `srand(time())`, as the reference build |
| `Math.RandomGenerator` | complete (MT19937, `serialize`/restore)                                               |
| `Date`, `RegExp`       | not yet                                                                               |

`Array.sort` uses the Visual C++ introsort, so equal elements and the comparator call
sequence match the native build. `Array.load` and other text readers go through
`TjsHost.readText`, which may suspend.

## Verification

`tests/kirikiri-tjs2-runtime.test.mjs`: variant conversions and formatting, operators,
member-table order, missing members, native classes and reference counting, finalization,
suspension, the built-in classes.
