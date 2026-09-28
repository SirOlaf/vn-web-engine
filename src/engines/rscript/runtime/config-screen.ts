import {RScriptContainer} from '../graphics/sprite.js';
import type {RScriptImages} from '../images.js';
import {Config, type RScriptMemory} from '../memory.js';
import {RScriptTextBlock, type GlyphRasterizer} from './text-block.js';
import {ImageButton, OptionGroup, ScreenImage, Slider} from './widgets.js';

/** Settings whose change needs the game's attention (the callbacks at +380..+400). */
export type ConfigChange =
  | 'screen'
  | 'speed'
  | 'sound'
  | 'music'
  | 'panel'
  | 'music-volume'
  | 'voice-volume'
  | 'sound-volume';
export type ConfigCommand = 'save' | 'load' | 'exit' | 'title' | 'close';

export interface ConfigScreenEnvironment {
  readonly memory: RScriptMemory;
  readonly images: RScriptImages;
  readonly rasterizer: GlyphRasterizer;
  readonly systemDirectory: string;
  readonly width: number;
  readonly height: number;
  readonly palette: readonly number[];
  /** sub_40EF00: the system sound, when sound effects are enabled. */
  sound(sound: number): void;
  changed(change: ConfigChange): void;
  command(command: ConfigCommand): void;
}

/** An option group bound to a configuration word (or system variable 7000 for `usr`). */
interface Setting {
  readonly names: readonly string[] | string;
  readonly offset: number | 'usr';
  readonly change?: ConfigChange;
}

/** Groups in construction order (0x40D070) and the words they edit (0x40EF20). */
const SETTINGS: readonly Setting[] = [
  {names: ['scm_wnd', 'scm_ful'], offset: Config.screenMode, change: 'screen'},
  {
    names: ['msp_now', 'msp_fst', 'msp_nom', 'msp_slw'],
    offset: Config.messageSpeed,
    change: 'speed',
  },
  {names: 'sef', offset: Config.soundEnabled, change: 'sound'},
  {names: 'bgm', offset: Config.musicEnabled, change: 'music'},
  {names: 'gef', offset: Config.effectsEnabled},
  {names: 'msk', offset: Config.skipUnread},
  {names: 'voc', offset: Config.voiceEnabled},
  {names: 'cmp', offset: 0x16, change: 'panel'},
  {names: 'usr', offset: 'usr'},
  {names: 'vocst', offset: Config.voiceContinues},
  {names: 'awh', offset: Config.autoHide},
  {names: 'bgr', offset: 0x18},
];

/** Volume sliders and the auto-mode wait (0x40F8A0). */
const SLIDERS = [
  {name: 'bgm', offset: Config.musicVolume, max: 255, change: 'music-volume'},
  {name: 'voc', offset: Config.voiceVolume, max: 255, change: 'voice-volume'},
  {name: 'sef', offset: Config.soundVolume, max: 255, change: 'sound-volume'},
  {name: 'auto', offset: Config.autoWait, max: 5000, change: null},
] as const;

/**
 * Configuration screen (0x40D070) from `confscrn`: option groups, sliders, the save, load,
 * title, close and exit buttons, and the current font name. Tabs, voice-bank toggles and
 * extra option pages of other titles are not built when their layers are absent.
 */
export class RScriptConfigScreen extends RScriptContainer {
  private readonly groups: {setting: Setting; group: OptionGroup}[] = [];
  private readonly sliders: {offset: number; slider: Slider}[] = [];
  private readonly buttons = new Map<ConfigCommand, ImageButton>();
  private fontButton: ImageButton | null = null;
  private fontName: RScriptTextBlock | null = null;
  private standalone = false;

  constructor(private readonly env: ConfigScreenEnvironment) {
    super(env.width, env.height);
    this.visible = false;
  }

  private read(offset: number | 'usr'): number {
    const {memory} = this.env;
    return offset === 'usr' ? memory.variables[7000]! : memory.configWord(offset) & 0xffff;
  }
  private write(offset: number | 'usr', value: number): void {
    const {memory} = this.env;
    if (offset === 'usr') memory.variables[7000] = value;
    else memory.setConfigWord(offset, value);
  }

  async load(): Promise<void> {
    const image = await ScreenImage.open(this.env.images, `${this.env.systemDirectory}\\confscrn`);
    if (!image) return;
    this.setPosition((this.env.width - image.width) >> 1, (this.env.height - image.height) >> 1);
    const background = await image.sprite('bg');
    if (background) this.add(background, 0);
    for (const setting of SETTINGS) {
      const change = (value: number): void => this.choose(setting, value);
      const group =
        typeof setting.names === 'string'
          ? await OptionGroup.toggle(image, setting.names, change)
          : await OptionGroup.create(image, setting.names, change);
      for (const button of group.buttons) this.add(button, 1);
      this.groups.push({setting, group});
    }
    for (const {name, offset, max, change} of SLIDERS) {
      const slider = await Slider.create(image, name, max, (value) => {
        this.write(offset, value);
        if (change) this.env.changed(change);
      });
      if (!slider) continue;
      this.add(slider.track, 10);
      this.add(slider.knob, 10);
      this.sliders.push({offset, slider});
    }
    const commands: [ConfigCommand, string][] = [
      ['load', 'load'],
      ['save', 'save'],
      ['exit', 'exit'],
      ['title', 'title'],
      ['close', 'close'],
    ];
    for (const [command, name] of commands) {
      const button = await image.button(name, () => this.env.command(command));
      if (!button) continue;
      this.buttons.set(command, button);
      this.add(button, 10);
    }
    // The font button (0x4501E0) shows the font name in its `font_txt` rectangle, or over
    // the whole button without one (0x4504D0). The native font window it opens is not
    // available in browsers, so pressing it does nothing.
    const fontButton = await image.button('font', () => {});
    this.fontButton = fontButton;
    if (fontButton) this.add(fontButton, 1);
    const font =
      (await image.rect('font_txt')) ??
      (fontButton && {
        x: fontButton.x,
        y: fontButton.y,
        width: fontButton.width,
        height: fontButton.height,
      });
    if (font) {
      // sub_4507F0 as the screen calls it: white, face 2, the rectangle's height.
      this.fontName = new RScriptTextBlock(this.env.rasterizer, 32, {
        face: 2,
        size: font.height,
        color: 0xffffff,
        palette: this.env.palette,
        shadow: false,
        speed: 0,
        lineSpacing: 0,
        charSpacing: 0,
        indent: 0,
        firstIndent: 0,
        align: 0,
        width: font.width,
        height: font.height,
        rubyFace: 0,
        rubySize: 12,
        rubyRaise: 0,
      });
      this.fontName.resize(font.width, font.height);
      this.fontName.setPosition(font.x, font.y);
      this.add(this.fontName, 2);
    }
  }

  /** The group callbacks (0x40FAF0..0x40FF60): store, sound and notify. */
  private choose(setting: Setting, value: number): void {
    const turningSoundOn = setting.change === 'sound' && value !== 0;
    if (setting.change !== 'sound') this.env.sound(1);
    this.write(setting.offset, value);
    // Sound effects play their confirmation only after being switched on (0x40FBF0).
    if (turningSoundOn) this.env.sound(1);
    if (setting.change) this.env.changed(setting.change);
    this.refresh();
  }

  /**
   * sub_40EF20: opens the screen. Standalone (from the title) it offers only the title
   * button; in the game, save and load appear when the script allows them.
   */
  open(standalone: boolean, saveAndLoad: boolean): void {
    this.standalone = standalone;
    const visible = (command: ConfigCommand, shown: boolean): void => {
      const button = this.buttons.get(command);
      if (!button) return;
      button.show(shown);
      button.interactive = shown;
    };
    visible('load', !standalone && saveAndLoad);
    visible('save', !standalone && saveAndLoad);
    visible('exit', !standalone);
    visible('title', true);
    visible('close', !standalone);
    this.refresh();
    this.show(true);
  }
  get isStandalone(): boolean {
    return this.standalone;
  }

  /** sub_411560 / sub_40F8A0: shows the stored values. */
  refresh(): void {
    for (const {setting, group} of this.groups) group.set(this.read(setting.offset));
    for (const {offset, slider} of this.sliders) slider.set(this.read(offset));
    const block = this.fontName;
    if (block) {
      const {memory} = this.env;
      const field = memory.config.subarray(Config.fontName, Config.fontName + 32);
      const end = field.indexOf(0);
      block.clear();
      block.append(field.subarray(0, end < 0 ? field.length : end));
      block.finishReveal();
      block.show(true);
    }
  }

  close(): void {
    for (const button of this.buttons.values()) button.unfocus();
    this.fontButton?.unfocus();
    this.show(false);
  }
}
