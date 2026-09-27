import {
  decodeGscInstruction,
  isGscExpression,
  type GscOpcodeLayouts,
  type GscProgram,
} from '../../../formats/rscript/gsc.js';
import {Scene, VARIABLE_COUNT, type RScriptMemory} from '../memory.js';
import {expandScriptText} from '../text.js';

/** Maximum nested call depth accepted by 0x424E10/0x424EF0 before they report an error. */
export const MAX_CALL_DEPTH = 9;

export type RScriptNativeHandler = (
  vm: RScriptInterpreter,
  operands: readonly number[],
) => void | Promise<void>;

export interface RScriptInterpreterHost {
  program(script: number): Promise<GscProgram>;
  /** Unknown opcodes run the native default case: yield one frame without operands. */
  yieldFrame(): Promise<void>;
  diagnostic?(message: string): void;
}

/** Thrown by opcode 0x08 and by `stop()` to unwind the script coroutine. */
export class RScriptScriptEnd extends Error {
  constructor(readonly reason: 'end' | 'stopped') {
    super(`RScript program ${reason}`);
    this.name = 'RScriptScriptEnd';
  }
}

/** MSVC `rand()`, seeded like 0x4217F0 unless the host provides a deterministic seed. */
export class MsvcRandom {
  constructor(private seed: number) {}
  static fromClock(date = new Date()): MsvcRandom {
    const h = date.getUTCHours(),
      m = date.getUTCMinutes(),
      s = date.getUTCSeconds(),
      ms = date.getUTCMilliseconds();
    return new MsvcRandom((ms + 100 * (s + 60 * (m + 20 * h))) >>> 0);
  }
  next(): number {
    this.seed = (Math.imul(this.seed, 214013) + 2531011) >>> 0;
    return (this.seed >>> 16) & 0x7fff;
  }
}

/**
 * GSC interpreter matching the RScript dispatcher (0x422FD0). The script thread of the
 * native engine becomes this coroutine; opcodes that block natively await host promises.
 * Control flow, calls, variables and expressions are handled here; every other opcode is
 * delegated to the registered native handlers.
 */
export class RScriptInterpreter {
  program: GscProgram | null = null;
  script = -1;
  pc = 0;
  private stopped = false;

  constructor(
    readonly memory: RScriptMemory,
    readonly layouts: GscOpcodeLayouts,
    readonly handlers: ReadonlyMap<number, RScriptNativeHandler>,
    private readonly host: RScriptInterpreterHost,
    readonly random: MsvcRandom = MsvcRandom.fromClock(),
  ) {}

  get depth(): number {
    return this.memory.sceneUword(Scene.callDepth);
  }
  set depth(value: number) {
    this.memory.setSceneWord(Scene.callDepth, value);
  }
  scriptAt(depth: number): number {
    return this.memory.sceneUword(Scene.scriptStack + depth * 2);
  }
  setScriptAt(depth: number, script: number): void {
    this.memory.setSceneWord(Scene.scriptStack + depth * 2, script);
  }
  returnAt(depth: number): number {
    return this.memory.sceneDword(Scene.returnStack + depth * 4);
  }
  setReturnAt(depth: number, offset: number): void {
    this.memory.setSceneDword(Scene.returnStack + depth * 4, offset);
  }

  variable(index: number): number {
    return index >= 0 && index < VARIABLE_COUNT ? this.memory.variables[index]! : 0;
  }
  setVariable(index: number, value: number): void {
    if (index >= 0 && index < VARIABLE_COUNT) this.memory.variables[index] = value;
    else this.host.diagnostic?.(`variable ${index} is out of range`);
  }
  /** `value` operands: the low word is the value, the high word counts indirections. */
  value(raw: number): number {
    let value = (raw << 16) >> 16;
    for (let levels = raw >> 16; levels > 0; levels--) value = this.variable(value);
    return value;
  }
  string(index: number): Uint8Array {
    const text = this.program?.strings[index];
    if (!text) throw new Error(`GSC string ${index} is out of range in script ${this.script}`);
    return text;
  }
  /** Applies `@` variable and `$` string-register expansion (0x424BE0). */
  expand(bytes: Uint8Array): Uint8Array {
    return expandScriptText(
      bytes,
      (levels, value) => {
        for (; levels > 0; levels--) value = this.variable(value);
        return value;
      },
      (index) =>
        this.memory.sceneString(
          Scene.stringRegisters + index * Scene.stringStride,
          Scene.stringStride,
        ),
    );
  }
  expandString(index: number): Uint8Array {
    return this.expand(this.string(index));
  }

  /** sub_424D30: records and loads the script for the current depth. */
  async load(script: number): Promise<void> {
    this.setScriptAt(this.depth, script);
    if (this.script !== script || !this.program) {
      this.program = await this.host.program(script);
      this.script = script;
    }
  }
  jump(offset: number): void {
    if (!this.program || offset < 0 || offset >= this.program.code.length)
      throw new Error(`GSC jump to 0x${offset.toString(16)} is outside script ${this.script}`);
    this.pc = offset;
  }
  /** Label names come from the calling program's strings, before the target loads. */
  labelName(labelString: number): Uint8Array | null {
    return labelString ? this.expandString(labelString) : null;
  }
  /** 0x41AB00: exact match over labels 1..n; unknown names select offset 0. */
  labelOffset(name: Uint8Array | null): number {
    if (!name?.length) return 0;
    const labels = this.program?.labels ?? [];
    for (let i = 1; i < labels.length; i++) {
      const label = labels[i]!;
      if (label.name.length === name.length && label.name.every((b, j) => b === name[j]))
        return label.offset;
    }
    return 0;
  }

  /** Starts at `offset` of the current depth's script (0x41DF70). */
  async resume(): Promise<void> {
    await this.load(this.scriptAt(this.depth));
    this.jump(this.returnAt(this.depth));
  }

  stop(): void {
    this.stopped = true;
  }

  /** Runs until opcode 0x08 ends the program or `stop()` is called. */
  async run(): Promise<void> {
    this.stopped = false;
    try {
      for (;;) await this.step();
    } catch (error) {
      if (error instanceof RScriptScriptEnd) return;
      throw error;
    }
  }

  async step(): Promise<void> {
    if (this.stopped) throw new RScriptScriptEnd('stopped');
    const program = this.program;
    if (!program) throw new Error('No GSC program is loaded');
    // Every iteration records the current instruction as the depth's resume point.
    this.setReturnAt(this.depth, this.pc);
    if (this.pc >= program.code.length) {
      // Reads past the end return zero natively, which decodes as the default case.
      await this.host.yieldFrame();
      return;
    }
    const opcode = program.code[this.pc]! | (program.code[this.pc + 1]! << 8);
    if (!isGscExpression(opcode) && !this.layouts.has(opcode)) {
      this.pc += 2;
      await this.host.yieldFrame();
      return;
    }
    const instruction = decodeGscInstruction(program.code, this.pc, this.layouts);
    this.pc = instruction.next;
    const operands = instruction.operands;
    if (isGscExpression(opcode)) {
      this.expression(opcode, operands);
      return;
    }
    switch (opcode) {
      case 0x03:
        if (!this.memory.registers[0]) this.jump(operands[0]!);
        return;
      case 0x04:
        if (this.memory.registers[0]) this.jump(operands[0]!);
        return;
      case 0x05:
        this.jump(operands[0]!);
        return;
      case 0x08:
        throw new RScriptScriptEnd('end');
      case 0x09:
        this.memory.registers[operands[0]! % this.memory.registers.length] = this.random.next();
        return;
      case 0x0c:
        await this.goto(this.value(operands[0]!), operands[1]!);
        return;
      case 0x0f:
        await this.call(this.value(operands[0]!), operands[1]!, operands.slice(2));
        return;
      case 0x10:
        await this.return(this.value(operands[0]!));
        return;
      case 0xc8:
        this.localCall(operands[0]!, operands.slice(1));
        return;
    }
    const handler = this.handlers.get(opcode);
    if (handler) await handler(this, operands);
    else await this.host.yieldFrame();
  }

  /** 0x424D90: replaces the current depth's script, then jumps to the label or start. */
  async goto(script: number, label: number): Promise<void> {
    const name = this.labelName(label);
    await this.load(script);
    this.jump(this.labelOffset(name));
  }

  private setParameters(values: readonly number[]): void {
    for (let i = 0; i < 10; i++) this.setVariable(10 + i, this.value(values[i] ?? 0));
  }

  /** 0x424E10: calls a script label with ten parameters in variables 10..19. */
  async call(script: number, label: number, parameters: readonly number[]): Promise<void> {
    if (this.depth >= MAX_CALL_DEPTH) throw new Error('RScript call stack overflow');
    const values = parameters.map((raw) => this.value(raw));
    this.setReturnAt(this.depth, this.pc);
    const name = this.labelName(label);
    this.depth++;
    await this.load(script);
    this.jump(this.labelOffset(name));
    for (let i = 0; i < 10; i++) this.setVariable(10 + i, values[i] ?? 0);
  }

  /** 0x424EF0: calls a code offset in the current script. */
  localCall(target: number, parameters: readonly number[]): void {
    if (this.depth >= MAX_CALL_DEPTH) throw new Error('RScript call stack overflow');
    this.setReturnAt(this.depth, this.pc);
    this.setScriptAt(this.depth + 1, this.scriptAt(this.depth));
    this.depth++;
    this.jump(target);
    this.setParameters(parameters);
  }

  /** 0x424F80: returns to the caller and stores the result in variable 0. */
  async return(result: number): Promise<void> {
    if (!this.depth) throw new Error('RScript call stack underflow');
    this.depth--;
    await this.load(this.scriptAt(this.depth));
    this.jump(this.returnAt(this.depth));
    this.setVariable(0, result);
  }

  private operand(opcode: number, value: number, left: boolean): number {
    const high = opcode >>> 8;
    const mode = left ? (high >>> 2) & 3 : high & 3;
    const levels = left ? (opcode >>> 4) & 0xf : opcode & 0xf;
    if (mode === 0) return value;
    if (mode === 1) return this.memory.registers[value] ?? 0;
    if (mode === 2) return this.variable(this.dereference(levels, value));
    return 0;
  }
  private dereference(levels: number, index: number): number {
    for (; levels > 0; levels--) index = this.variable(index);
    return index;
  }

  /** Expression family (0x422A30..0x422F20); results are stored as signed words. */
  private expression(opcode: number, operands: readonly number[]): void {
    const registers = this.memory.registers;
    const target = operands[0]!;
    const store = (value: number): void => {
      if (target < registers.length) registers[target] = value;
    };
    if ((opcode & 0xf000) === 0xf000) {
      store(this.operand(opcode, operands[1]!, false));
      return;
    }
    const [, a, b] = operands as [number, number, number];
    const right = (): number => this.operand(opcode, b, false);
    const left = (): number => this.operand(opcode, a, true);
    switch (opcode & 0xf000) {
      case 0x1000: {
        const value = right();
        const mode = (opcode >>> 10) & 3;
        if (mode === 1) registers[a] = value;
        else if (mode === 2) this.setVariable(this.dereference((opcode >>> 4) & 0xf, a), value);
        store(value);
        return;
      }
      case 0x2000:
        store(left() || right() ? 1 : 0);
        return;
      case 0x3000:
        store(left() && right() ? 1 : 0);
        return;
      case 0x4000:
        store(left() === right() ? 1 : 0);
        return;
      case 0x5000:
        store(left() >= right() ? 1 : 0);
        return;
      case 0x6000:
        store(left() > right() ? 1 : 0);
        return;
      case 0x7000:
        store(left() <= right() ? 1 : 0);
        return;
      case 0x8000:
        store(left() < right() ? 1 : 0);
        return;
      case 0x9000:
        store(left() !== right() ? 1 : 0);
        return;
      case 0xa000:
        store(left() + right());
        return;
      case 0xb000:
        store(left() - right());
        return;
      case 0xc000:
        store(Math.imul(left(), right()));
        return;
      case 0xd000:
      case 0xe000: {
        const dividend = left(),
          divisor = right();
        if (!divisor) {
          this.host.diagnostic?.(`division by zero in script ${this.script}`);
          store(0);
          return;
        }
        store(opcode & 0x1000 ? Math.trunc(dividend / divisor) : dividend % divisor);
        return;
      }
    }
  }
}
