import {Scene, type RScriptMemory} from '../memory.js';
import type {RScriptGame} from './game.js';
import {messageSetting19} from './message-window-19.js';

/**
 * Character x positions (word_47EEBA): six per text column (placement / 3), then the fixed
 * positions (word_47EEDE). Layer 7 reads one entry past each run, as the native does.
 */
const POSITIONS = [
  0, 200, 200, 300, 400, 500, 600, 200, 200, 300, 400, 500, 600, 600, 600, 500, 400, 300, 200, 400,
  200, 300, 400, 500, 600, 27694,
];
/** The first fixed position, for layer 0. */
const FIXED = 18;
/** Character layers 1..7; focus and rebuilds touch 1..6. */
const LAST_CHARACTER = 7;
const FOCUSED_LAYERS = 6;
/** The focused character's layer (variable 20, written by 0x431440). */
const FOCUS_VARIABLE = 20;

/** The x of character `layer` for the message settings (0x431370). */
function characterX(memory: RScriptMemory, layer: number): number {
  const index = messageSetting19(memory, 'fixedCharacters')
    ? FIXED + layer
    : 6 * Math.trunc(messageSetting19(memory, 'placement') / 3) + layer;
  return POSITIONS[index] ?? 0;
}

/**
 * RScript 1.9 characters (opcode 0xFF, 0x431320): layers 1..7 placed clear of the message
 * text, with the speaking character in front and the others dimmed.
 */
export class RScriptCharacters {
  constructor(private readonly game: RScriptGame) {}

  private get skipping(): boolean {
    return this.game.flags.fastSkip;
  }
  private setPriority(index: number, order: number): void {
    const layer = this.game.layers[index]!;
    this.game.memory.setSceneWord(Scene.layerOrders + 2 * index, order);
    if (!this.skipping) this.game.root.setPriority(layer, order);
  }
  /** The speaker at full strength, the rest dimmed unless the settings keep them lit. */
  private lit(index: number, focused: boolean): void {
    const keep = focused || messageSetting19(this.game.memory, 'keepCharacters') !== 0;
    this.game.layers[index]!.setBlend(keep ? 0 : 4, keep ? 0 : 50, this.skipping);
  }

  /** sub_431370: shows `image` on layer `layer`, focusing it unless `keepFocus`. */
  async show(layer: number, image: number, keepFocus: boolean): Promise<void> {
    if (!layer || layer > LAST_CHARACTER) return;
    const x = characterX(this.game.memory, layer);
    await this.game.layers[layer]!.load(image, 0, x, 0, 0, this.skipping);
    if (!keepFocus) this.focus(layer);
  }
  /** sub_431410 */
  hide(layer: number): void {
    this.game.layers[layer]?.hide(0, this.skipping);
  }
  /** sub_431440: the speaker goes in front (priority 8); the others return to their order. */
  focus(layer: number): void {
    this.game.memory.variables[FOCUS_VARIABLE] = layer;
    for (let index = 1; index <= FOCUSED_LAYERS; index++) {
      this.setPriority(index, index === layer ? 8 : index);
      this.lit(index, index === layer);
    }
  }
  /** sub_4314C0: places and lights the characters again after a rebuild. */
  restore(): void {
    const focused = this.game.memory.variables[FOCUS_VARIABLE];
    for (let index = 1; index <= FOCUSED_LAYERS; index++) {
      this.game.layers[index]!.moveTo(0, characterX(this.game.memory, index), 0, 0, this.skipping);
      this.lit(index, index === focused);
    }
  }
}
