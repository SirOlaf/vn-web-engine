import type {EmoteIcon, EmoteModel} from '../../../../formats/kirikiri/emote-model.js';
import {emoteBuild, EMOTEDRIVER_X86_SHA256, EMOTEDRIVER_X64_SHA256} from '../../build.js';

/** Resolved icon and its owning file; source indices belong to that file. */
export interface EmoteSourceIcon<File extends EmoteModel = EmoteModel> {
  readonly file: File;
  readonly source: string;
  /** Source enumeration index in the owning file. */
  readonly sourceIndex: number;
  readonly icon: EmoteIcon;
}

/** Source storage supplied by the layer, independent of its native node layout. */
export interface EmoteSourceTarget<File extends EmoteModel = EmoteModel> {
  srcKey: string | null | undefined;
  iconKey: string | null | undefined;
  drawable: boolean;
  hidden: boolean;
  attr: number;
  texture: number;
  originX: number;
  originY: number;
  file?: File | null;
  source?: string | null;
  resolution?: number;
  /** Blank sources retain the previous rectangle's left/top. */
  setSourceSize(width: number, height: number): void;
  /** The target retains its native integer-store behavior. */
  setSourceRect(left: number, top: number, width: number, height: number): void;
}

/** Only current-frame keys are needed by the source pass. */
export interface EmoteSourceFrame {
  readonly empty: boolean;
  readonly src: string | null;
  readonly icon: string | null;
}

/** Atlas indices supplied by the x86 renderer's clip binding. */
export interface EmoteSourceTextures {
  textureIndexOf(source: string): number;
}

/**
 * 0x10038a30 / 0x18003dc40: source lookup, cached keys and blank/icon stores. The
 * x64 resource searches its current file first; x86 owns one model and obtains
 * atlas indices from its renderer. Failed lookups retain the prior rectangle.
 */
export class EmoteSourceResolver<File extends EmoteModel = EmoteModel> {
  private readonly x64: boolean;
  constructor(
    private readonly files: readonly File[],
    driverSha256 = EMOTEDRIVER_X86_SHA256,
    private readonly textures?: EmoteSourceTextures,
  ) {
    this.x64 = emoteBuild(driverSha256) === EMOTEDRIVER_X64_SHA256;
  }

  /** 0x1002c3a0 / 0x180031810: preserve file and source enumeration order. */
  findIcon(
    src: string | null,
    icon: string | null,
    current: File | null,
  ): EmoteSourceIcon<File> | null {
    if (src === null || icon === null) return null;
    const order = current ? [current, ...this.files.filter((f) => f !== current)] : this.files;
    for (const file of order) {
      const found = file.sources.get(src)?.icons.get(icon);
      if (!found) continue;
      let sourceIndex = 0;
      for (const name of file.sources.keys()) {
        if (name === src) break;
        sourceIndex++;
      }
      return {file, source: src, sourceIndex, icon: found};
    }
    return null;
  }

  /** True only when the source keys change and the mesh divisions need updating. */
  resolve(target: EmoteSourceTarget<File>, frame: EmoteSourceFrame, current: File | null): boolean {
    if (frame.empty || (target.srcKey === frame.src && target.iconKey === frame.icon)) return false;
    target.srcKey = frame.src;
    target.iconKey = frame.icon;
    if (frame.src === 'blank') {
      target.drawable = true;
      target.hidden = true;
      target.attr = 0;
      const parts = (frame.icon ?? '').split(':');
      if (this.x64) {
        target.setSourceSize(
          Number.parseInt(parts[0] ?? '', 10) || 0,
          Number.parseInt(parts[1] ?? '', 10) || 0,
        );
        target.originX = Math.fround(Number.parseFloat(parts[2] ?? '') || 0);
        target.originY = Math.fround(Number.parseFloat(parts[3] ?? '') || 0);
        target.resolution = 1;
      } else {
        target.texture = -1;
        target.setSourceSize(atoi(parts[0]), atoi(parts[1]));
        target.originX = Math.fround(atof(parts[2]));
        target.originY = Math.fround(atof(parts[3]));
      }
    } else {
      if (this.x64) {
        const resolved = this.findIcon(frame.src, frame.icon, current);
        target.drawable = resolved !== null;
        target.hidden = false;
        if (resolved) {
          const icon = resolved.icon;
          target.file = resolved.file;
          target.source = resolved.source;
          target.texture = resolved.sourceIndex;
          target.attr = icon.attr;
          target.setSourceRect(icon.left ?? 0, icon.top ?? 0, icon.width, icon.height);
          target.originX = Math.fround(icon.originX);
          target.originY = Math.fround(icon.originY);
          target.resolution = Math.fround(icon.resolution!);
        }
      } else {
        const icon = this.files[0]?.sources.get(frame.src!)?.icons.get(frame.icon!);
        target.hidden = false;
        target.drawable = icon !== undefined;
        target.texture = this.textures ? this.textures.textureIndexOf(frame.src!) : -1;
        if (icon) {
          target.attr = icon.attr;
          target.originX = Math.fround(icon.originX);
          target.originY = Math.fround(icon.originY);
          target.setSourceRect(icon.left ?? 0, icon.top ?? 0, icon.width, icon.height);
        }
      }
    }
    return true;
  }
}

function atoi(s: string | undefined): number {
  const m = /^\s*[+-]?\d+/.exec(s ?? '');
  return m ? parseInt(m[0], 10) | 0 : 0;
}
function atof(s: string | undefined): number {
  const v = parseFloat(s ?? '');
  return Number.isNaN(v) ? 0 : v;
}
