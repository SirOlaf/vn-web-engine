import type {RScriptSurface} from '../graphics/pixels.js';
import {RScriptContainer, RScriptSprite} from '../graphics/sprite.js';
import type {RScriptImages} from '../images.js';

/** Companion panel commands in `compane.lwg` order of construction (0x415750). */
export const PANEL_COMMANDS = [
  'skip',
  'next',
  'rev',
  'fow',
  'bak',
  'hide',
  'voc',
  'auto',
  'menu',
  'save',
  'load',
  'extd',
  'qsave',
  'qload',
] as const;
export type PanelCommand = (typeof PANEL_COMMANDS)[number];

/** Two-image button (0x4499F0): `name` normally, `name_f` under the pointer. */
class PanelButton extends RScriptSprite {
  constructor(
    private readonly normal: RScriptSurface,
    private readonly focus: RScriptSurface | null,
  ) {
    super();
    this.setSurface(normal);
    this.onHover = (_, inside) => this.setSurface(inside && this.focus ? this.focus : this.normal);
  }
}

/**
 * Message companion panel: a background, the command buttons, the auto-speed slider and
 * the voice indicator. Buttons dispatch to the message window's command callbacks.
 */
export class RScriptMessagePanel extends RScriptContainer {
  private readonly buttons = new Map<PanelCommand, PanelButton>();
  private voiceOff: RScriptSprite | null = null;
  private slider: {track: RScriptSprite; knob: RScriptSprite; min: number; range: number} | null =
    null;

  constructor(
    private readonly command: (command: PanelCommand) => void,
    private readonly autoSpeed: (value: number) => void,
  ) {
    super();
    this.visible = false;
  }

  async load(images: RScriptImages, systemDirectory: string): Promise<void> {
    const path = `${systemDirectory}\\compane`;
    const lwg = await images.lwg(path);
    if (!lwg) return;
    this.resize(lwg.width, lwg.height);
    const layer = async (name: string): Promise<RScriptSprite | null> => {
      const entry = lwg.find(name);
      const surface = entry ? await images.lwgLayer(path, name) : null;
      if (!entry || !surface) return null;
      const sprite = new RScriptSprite();
      sprite.setSurface(surface);
      sprite.setPosition(entry.x, entry.y);
      return sprite;
    };
    const background = await layer('bg');
    if (background) {
      this.add(background, 0);
      background.show(true);
    }
    for (const name of PANEL_COMMANDS) {
      const entry = lwg.find(name);
      const normal = entry ? await images.lwgLayer(path, name) : null;
      if (!entry || !normal) continue;
      const focus = lwg.find(`${name}_f`) ? await images.lwgLayer(path, `${name}_f`) : null;
      const button = new PanelButton(normal, focus);
      button.setPosition(entry.x, entry.y);
      button.onPress = () => this.command(name);
      button.interactive = true;
      this.buttons.set(name, button);
      this.add(button, 1);
      button.show(name !== 'voc');
    }
    this.voiceOff = await layer('voc_off');
    if (this.voiceOff) {
      this.add(this.voiceOff, 1);
      this.voiceOff.show(true);
    }
    const track = await layer('slide_lev'),
      knob = await layer('slide');
    if (track && knob) {
      // Horizontal slider: the knob's centre travels across the track (0x4517E0).
      const min = track.x - (knob.width >> 1);
      this.slider = {track, knob, min, range: Math.max(1, track.width)};
      track.interactive = true;
      track.onPress = (_, at) => this.slide(at.x);
      this.add(track, 1);
      this.add(knob, 2);
      track.show(true);
      knob.show(true);
    }
  }

  private slide(x: number): void {
    const slider = this.slider;
    if (!slider) return;
    const value = Math.round((255 * Math.max(0, Math.min(slider.range, x))) / slider.range);
    this.setAutoSpeed(value);
    this.autoSpeed(value);
  }

  /** sub_4179F0: places the slider knob for an auto speed of 0..255. */
  setAutoSpeed(value: number): void {
    const slider = this.slider;
    if (!slider) return;
    slider.knob.setPosition(slider.min + Math.round((value * slider.range) / 255), slider.knob.y);
  }

  /** sub_416DC0: the voice button replaces its disabled image when the page has a voice. */
  setVoice(available: boolean): void {
    this.buttons.get('voc')?.show(available);
    this.voiceOff?.show(!available);
  }

  /** vtable +104 on the panel: its buttons accept input only while the script waits. */
  setInput(enabled: boolean): void {
    for (const button of this.buttons.values()) button.interactive = enabled;
    if (this.slider) this.slider.track.interactive = enabled;
  }
}
