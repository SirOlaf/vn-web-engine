/**
 * Compiled TJS2 code: what the code generator produces from a script block and what the
 * bytecode reader produces from `TJS2100` data. It is plain data, independent of a running
 * engine; the VM instantiates it (`vm/link.ts`) into context objects
 * (`tTJSInterCodeContext`).
 */

/** `tTJSContextType`. */
export const ContextType = {
  TopLevel: 0,
  Function: 1,
  ExprFunction: 2,
  Property: 3,
  PropertySetter: 4,
  PropertyGetter: 5,
  Class: 6,
  SuperClassGetter: 7,
} as const;
export type ContextType = (typeof ContextType)[keyof typeof ContextType];

/** `GetContextTypeName`. */
export function contextTypeName(type: ContextType): string {
  return (
    [
      'top level script',
      'function',
      'function expression',
      'property',
      'property setter',
      'property getter',
      'class',
      'super class getter proxy',
    ][type] ?? 'unknown'
  );
}

/**
 * An entry of a context's data area (`DataArea`). Contexts are referenced by their index in
 * the block. Constant arrays and dictionaries (`(const) [ … ]`) are built when the block is
 * instantiated; TJS2 bytecode cannot hold them.
 */
export type DataItem =
  | {readonly kind: 'void'}
  | {readonly kind: 'null'}
  | {readonly kind: 'integer'; readonly value: bigint}
  | {readonly kind: 'real'; readonly value: number}
  | {readonly kind: 'string'; readonly value: string}
  | {readonly kind: 'octet'; readonly value: Uint8Array}
  | {readonly kind: 'context'; readonly index: number}
  | {readonly kind: 'array'; readonly items: readonly DataItem[]}
  | {readonly kind: 'dictionary'; readonly items: readonly (readonly [string, DataItem])[]};

/** One compiled context (function, class, property handler, top level, …). */
export interface ContextCode {
  readonly name: string | null;
  readonly type: ContextType;
  /** Index of the enclosing context, or -1. */
  readonly parent: number;
  /** Local variable slots (arguments first), `MaxVariableCount`. */
  readonly maxVariableCount: number;
  /** Registers below the locals: `this` (-1) and the this-proxy (-2); 0 for properties. */
  readonly variableReserveCount: number;
  /** Highest temporary register used (`MaxFrameCount`). */
  readonly maxFrameCount: number;
  /** Declared parameters (`FuncDeclArgCount`). */
  readonly funcDeclArgCount: number;
  /** First argument that `*` passes on (`FuncDeclUnnamedArgArrayBase`). */
  readonly funcDeclUnnamedArgArrayBase: number;
  /** Parameter collecting the remaining arguments into an array, or -1. */
  readonly funcDeclCollapseBase: number;
  readonly propSetter: number;
  readonly propGetter: number;
  readonly superClassGetter: number;
  readonly code: Int32Array;
  readonly data: readonly DataItem[];
  /**
   * Source lines by code position, ascending by position: the line of the instruction at
   * `codePositions[i]` and later ones, up to the next entry, is `lines[i]` (1-based, with the
   * block's line offset).
   */
  readonly codePositions: Int32Array;
  readonly lines: Int32Array;
  /** Entry points of the super-class getter, one per base class (`SuperClassGetterPointer`). */
  readonly superClassGetterPointers: readonly number[];
  /**
   * Members set on this context when the block is instantiated, in order: the functions,
   * properties and classes declared inside a function or class (`RegisterFunction`).
   */
  readonly members: readonly {readonly name: string; readonly context: number}[];
}

export interface CodeBlock {
  /** Block name for positions; empty for unnamed blocks. */
  readonly name: string;
  readonly lineOffset: number;
  /** Contexts in creation order. */
  readonly contexts: readonly ContextCode[];
  /** Index of the top-level context, or -1. */
  readonly topLevel: number;
}

/** `CodePosToSrcPos` and `SrcPosToLine`: the source line of a code position. */
export function lineOfCodePosition(ctx: ContextCode, position: number): number {
  const pos = ctx.codePositions;
  if (pos.length === 0) return 1;
  let s = 0,
    e = pos.length;
  while (e - s > 1) {
    const m = s + ((e - s) >> 1);
    if (pos[m]! > position) e = m;
    else s = m;
  }
  return ctx.lines[s]!;
}
