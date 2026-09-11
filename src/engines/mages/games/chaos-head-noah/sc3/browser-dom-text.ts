import {CanvasDrawTarget, type DrawCommand} from '../../../../../graphics/draw-list.js';
import type {TriangleImage} from '../../../../../graphics/triangle-draw.js';
import {BrowserAtlasFonts} from '../../../../../text/browser-atlas-font.js';
import {DomGlyphSlots} from '../../../../../text/dom-glyph-slots.js';
import type {CapturedDialogFrame} from './dialog-canvas.js';

/** Browser presentation only. The ordinary target still executes every native
 * command and owns all VM captures/readbacks. This renderer never publishes to it. */
export class BrowserDomText {
  readonly text: DomGlyphSlots;
  private readonly target = new CanvasDrawTarget(document.createElement('canvas'), 1920, 1080, {
    transparent: true,
  });
  private readonly layers: HTMLCanvasElement[] = [];
  private readonly resize: ResizeObserver;
  private readonly fonts = new BrowserAtlasFonts(() => {
    if (this.latest && !this.text.element.hidden)
      this.show(this.latest.frame, this.latest.captures);
  });
  private latest:
    {frame: CapturedDialogFrame; captures: ReadonlyMap<DrawCommand, TriangleImage>} | undefined;
  constructor(
    parent: HTMLElement,
    readonly canvas: HTMLCanvasElement,
  ) {
    this.text = new DomGlyphSlots(parent);
    this.text.element.hidden = true;
    const fit = () => {
      const r = canvas.getBoundingClientRect(),
        p = parent.getBoundingClientRect(),
        scale = Math.min(r.width / 1920, r.height / 1080);
      Object.assign(this.text.element.style, {
        left: `${r.left - p.left + (r.width - 1920 * scale) / 2}px`,
        top: `${r.top - p.top + (r.height - 1080 * scale) / 2}px`,
        transform: `scale(${scale})`,
      });
    };
    this.resize = new ResizeObserver(fit);
    this.resize.observe(canvas);
    fit();
  }
  show(frame: CapturedDialogFrame, captures: ReadonlyMap<DrawCommand, TriangleImage>): void {
    this.latest = {frame, captures};
    const plan = frame.text;
    if (!plan) return;
    const families = new Map<string, string>();
    for (const slots of plan.after.values())
      for (const slot of slots) {
        const family = this.fonts.request(slot, frame.textures);
        if (family) families.set(slot.id, family);
      }
    this.fonts.retain(new Set(families.values()));
    const after = new Map<DrawCommand, typeof plan.slots>(),
      omit = new Set<DrawCommand>();
    let active: number | null = null,
      split = false;
    const commands = (frame.draw.commands ?? frame.draw.sprites).map((command) => {
      let draw = command;
      if ('kind' in command && command.kind === 'target') active = command.texture;
      const captured = captures.get(command);
      if (captured && 'kind' in command && command.kind === 'capture')
        draw = {kind: 'texture', texture: command.texture, image: captured};
      // Independent transparent layers require accumulated source-over alpha.
      // Destination-dependent color blends before the first DOM slot remain native.
      if (
        split &&
        active === null &&
        'blendState' in draw &&
        draw.blendState?.color.source === 'source-alpha' &&
        draw.blendState.color.destination === 'inverse-source-alpha' &&
        draw.blendState.color.operation === 'add'
      )
        draw = {
          ...draw,
          blendState: {
            color: draw.blendState.color,
            alpha: {source: 'one', destination: 'inverse-source-alpha', operation: 'add'},
          },
        };
      const slots = plan.after.get(command)?.filter((slot) => families.has(slot.id));
      if (slots?.length) {
        after.set(draw, slots);
        split = true;
      }
      if (plan.omit.has(command) && families.has(plan.omitSlots.get(command)!)) omit.add(draw);
      return draw;
    });
    let layer = 0,
      z = 0;
    const visible = new Set<string>();
    for (const slot of plan.slots) this.text.buffers.set(slot.id, slot.glyphs);
    this.target.draw(
      {sprites: [], commands},
      (id) => {
        const image = frame.textures.get(id);
        if (!image) throw new Error(`Missing DOM presentation texture ${id}`);
        return image;
      },
      undefined,
      {
        after: new Set(after.keys()),
        omit,
        present: (surface, command) => {
          if (surface) {
            let canvas = this.layers[layer];
            if (!canvas) {
              canvas = document.createElement('canvas');
              canvas.width = 1920;
              canvas.height = 1080;
              canvas.style.cssText =
                'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
              this.layers.push(canvas);
              this.text.element.append(canvas);
            }
            canvas.hidden = false;
            canvas.style.zIndex = String(z++);
            const context = canvas.getContext('2d')!;
            context.globalCompositeOperation = 'copy';
            context.drawImage(surface, 0, 0);
            layer++;
          }
          for (const slot of command ? (after.get(command) ?? []) : []) {
            this.text.show(slot, z++, families.get(slot.id));
            visible.add(slot.id);
          }
        },
      },
    );
    for (const canvas of this.layers.splice(layer)) {
      canvas.remove();
      canvas.width = canvas.height = 0;
    }
    this.text.retain(visible, new Set(plan.slots.map((s) => s.id)));
    this.text.element.hidden = false;
  }
  hide(): void {
    this.text.element.hidden = true;
    for (const canvas of this.layers.splice(0)) {
      canvas.remove();
      canvas.width = canvas.height = 0;
    }
    this.target.dispose();
  }
  clear(): void {
    this.hide();
    this.latest = undefined;
    this.fonts.clear();
    this.text.clear();
  }
  dispose(): void {
    this.resize.disconnect();
    this.clear();
    this.text.dispose();
  }
}
