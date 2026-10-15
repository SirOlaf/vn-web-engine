/**
 * Instantiation of compiled code: one `InterCodeContext` per context of a `CodeBlock`, linked
 * as the native compiler leaves them (`Commit`, `RegisterFunction`) or the bytecode reader
 * builds them (`tTJSByteCodeLoader::ReadObjects`). Reference ownership is the native one: a
 * context is held by the data areas and members that refer to it, accessors by their
 * property, the super-class getter by its class; the returned top-level context carries one
 * reference for the caller.
 */
import type {CodeBlock, ContextCode, DataItem} from '../code-block.js';
import {forEachOperand} from '../opcodes.js';
import {
  TJS_IGNOREPROP,
  TJS_MEMBERENSURE,
  type Dispatch,
  type Variant,
} from '../runtime/interface.js';
import {addRefVariant} from '../runtime/slot.js';
import * as V from '../runtime/variant.js';
import {InterCodeContext} from './context.js';
import type {Vm} from './vm.js';

/** Instantiates every context of `block`; returns the top-level context, or null. */
export function instantiateBlock(vm: Vm, block: CodeBlock): InterCodeContext | null {
  const contexts = block.contexts.map((c) => new InterCodeContext(vm, block, c, registerLayout(c)));
  block.contexts.forEach((c, i) => {
    const ctx = contexts[i]!;
    ctx.parent = c.parent >= 0 ? contexts[c.parent]! : null;
    if (c.propGetter >= 0) (ctx.propGetter = contexts[c.propGetter]!).addRef();
    if (c.propSetter >= 0) (ctx.propSetter = contexts[c.propSetter]!).addRef();
    // The super-class getter keeps the reference it was created with; its class owns it.
    if (c.superClassGetter >= 0) ctx.superClassGetter = contexts[c.superClassGetter]!;
    ctx.data = c.data.map((d) => dataVariant(vm, d, contexts));
  });
  block.contexts.forEach((c, i) => {
    const ctx = contexts[i]!;
    for (const m of c.members)
      ctx.propSet(TJS_MEMBERENSURE | TJS_IGNOREPROP, m.name, V.obj(contexts[m.context]!), ctx);
  });
  const owned = new Set<number>();
  if (block.topLevel >= 0) owned.add(block.topLevel);
  for (const c of block.contexts) if (c.superClassGetter >= 0) owned.add(c.superClassGetter);
  contexts.forEach((ctx, i) => {
    if (!owned.has(i)) ctx.release();
  });
  return block.topLevel >= 0 ? contexts[block.topLevel]! : null;
}

/** A data item as a variant holding its references. */
function dataVariant(vm: Vm, d: DataItem, contexts: readonly InterCodeContext[]): Variant {
  if (d.kind === 'context') {
    const v = V.obj(contexts[d.index] ?? null);
    addRefVariant(v);
    return v;
  }
  const v = constantVariant(vm, d);
  addRefVariant(v);
  // A constant array or dictionary was created with one reference, which the variant replaces.
  if (v.type === 1) v.object?.release();
  return v;
}

/** A constant; an array or dictionary is new and carries its creation reference. */
function constantVariant(vm: Vm, d: DataItem): Variant {
  switch (d.kind) {
    case 'void':
      return V.VOID;
    case 'null':
      return V.NULL_OBJECT;
    case 'integer':
      return V.integer(d.value);
    case 'real':
      return V.real(d.value);
    case 'string':
      return V.str(d.value);
    case 'octet':
      return V.octet(d.value);
    case 'array': {
      const array = vm.engine.createArray();
      for (const item of d.items)
        withElement(vm, item, (v) => array.funcCall(0, 'add', null, [v], array));
      return V.obj(array, array);
    }
    case 'dictionary': {
      const dict = vm.engine.createDictionary();
      for (const [name, item] of d.items)
        withElement(vm, item, (v) => dict.propSet(TJS_MEMBERENSURE, name, v, null));
      return V.obj(dict, dict);
    }
    case 'context':
      throw new Error('context constants are linked separately');
  }
}

function withElement(vm: Vm, item: DataItem, add: (v: Variant) => void): void {
  const v = constantVariant(vm, item);
  add(v);
  if (v.type === 1) (v.object as Dispatch | null)?.release();
}

/**
 * Registers allocated per call: at least the compiled counts, and enough for every register
 * the code names (the native generator does not always count the base-class expression of a
 * class or a deleted local's `true`, and bytecode may name any register).
 */
export function registerLayout(c: ContextCode): {variables: number; frame: number} {
  let low = 0,
    high = 0;
  const code = c.code;
  for (let i = 0; i < code.length;) {
    i += forEachOperand(code, i, (p, kind) => {
      if (kind !== 'r') return;
      const r = code[p]!;
      if (r < low) low = r;
      if (r > high) high = r;
    });
  }
  const variables = Math.max(
    c.maxVariableCount,
    c.funcDeclArgCount,
    c.funcDeclCollapseBase + 1,
    -low - c.variableReserveCount,
    0,
  );
  return {variables, frame: Math.max(c.maxFrameCount, high)};
}
