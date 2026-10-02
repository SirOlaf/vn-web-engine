import {RScriptContainer, type RScriptSprite} from '../graphics/sprite.js';
import type {RScriptImages} from '../images.js';
import {ScreenImage, Slider, type ImageButton} from './widgets.js';

/**
 * Companion panel commands in `compane.lwg` order of construction (0x415750). A revision
 * builds the ones it has (`RScriptRevision.panelCommands`).
 */
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

/**
 * Message companion panel: a background, the command buttons, the window opacity slider
 * and the voice indicator. Buttons dispatch to the message window's command callbacks.
 */
export class RScriptMessagePanel extends RScriptContainer {
  private readonly buttons = new Map<PanelCommand, ImageButton>();
  private voiceOff: RScriptSprite | null = null;
  private slider: Slider | null = null;

  constructor(
    private readonly command: (command: PanelCommand) => void,
    private readonly windowAlpha: (value: number) => void,
  ) {
    super();
    this.visible = false;
  }

  async load(
    images: RScriptImages,
    systemDirectory: string,
    commands: readonly PanelCommand[],
  ): Promise<void> {
    const image = await ScreenImage.open(images, `${systemDirectory}\\compane`);
    if (!image) return;
    this.resize(image.width, image.height);
    const background = await image.sprite('bg');
    if (background) this.add(background, 0);
    for (const name of commands) {
      const button = await image.button(name, () => this.command(name));
      if (!button) continue;
      this.buttons.set(name, button);
      this.add(button, 1);
      button.show(name !== 'voc');
    }
    this.voiceOff = await image.sprite('voc_off');
    if (this.voiceOff) this.add(this.voiceOff, 1);
    // The `slide_lev` rectangle and `slide` knob (0x415750, sub_4517E0), values 0..255.
    this.slider = await Slider.create(image, 'slide_lev', 'slide', 255, (value) =>
      this.windowAlpha(value),
    );
    if (this.slider) {
      this.add(this.slider.track, 1);
      this.add(this.slider.knob, 1);
    }
  }

  /** sub_418360: places the knob for a window opacity of 0..255. */
  setWindowAlpha(value: number): void {
    this.slider?.set(value);
  }

  /** sub_416DC0: the voice button replaces its disabled image when the page has a voice. */
  setVoice(available: boolean): void {
    this.buttons.get('voc')?.show(available);
    this.voiceOff?.show(!available);
  }

  /** vtable +104 on the panel: its buttons accept input only while the script waits. */
  setInput(enabled: boolean): void {
    for (const button of this.buttons.values()) {
      button.interactive = enabled;
      if (!enabled) button.unfocus();
    }
    if (this.slider) this.slider.track.interactive = enabled;
    if (!enabled) this.slider?.knob.unfocus();
  }
}
