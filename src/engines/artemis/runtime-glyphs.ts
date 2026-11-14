import {artemisDefaultFontAttributes} from './font-state.js';
import type {ArtemisTextBlock} from './text-block.js';
import {
  ArtemisGlyphRenderer,
  type ArtemisTextGlyphResource,
  type ArtemisTextGlyphStyle,
} from './text-glyphs.js';
import {ArtemisTextInsertion, type ArtemisInsertionStyle} from './text-insertion.js';
import type {ArtemisMessageResource, ArtemisRuntimeGlyphs} from './runtime.js';

/** Actual glyph blocks: font faces, rasterized and painted glyph surfaces. */
export interface ArtemisGlyphBlockSource {
  restoreFontCache?(path: string): Promise<void>;
  load(
    main: string,
    ruby: string,
    style: ArtemisTextGlyphStyle,
    renderer: ArtemisGlyphRenderer,
  ): Promise<ArtemisTextBlock<ArtemisTextGlyphResource>>;
}

/** One text insertion per message resource (the CLinkableTextLayer text owner). The style,
 * indentation, word parts and prohibition sets follow the resource on every lookup.
 * `loaded` observes each block a layer loads. */
export class ArtemisRuntimeGlyphOwner implements ArtemisRuntimeGlyphs {
  private readonly owners = new Map<ArtemisMessageResource, ArtemisTextInsertion>();
  constructor(
    private readonly hash: string,
    private readonly blocks: ArtemisGlyphBlockSource,
    private readonly loaded?: (
      resource: ArtemisMessageResource,
      block: ArtemisTextBlock<ArtemisTextGlyphResource>,
    ) => void,
  ) {}
  restoreFontCache(path: string): Promise<void> {
    if (!this.blocks.restoreFontCache) throw Error('Artemis font cache owner unavailable');
    return this.blocks.restoreFontCache(path);
  }
  private style(resource: ArtemisMessageResource): ArtemisInsertionStyle {
    return {
      ...artemisDefaultFontAttributes(this.hash),
      ...Object.fromEntries(resource.font),
    } as ArtemisInsertionStyle;
  }
  private host(resource: ArtemisMessageResource) {
    const renderer = new ArtemisGlyphRenderer();
    return {
      loadBlock: async (main: string, ruby: string, style: ArtemisTextGlyphStyle) => {
        const block = await this.blocks.load(main, ruby, style, renderer);
        this.loaded?.(resource, block);
        return block;
      },
      // Frames are drawn from the insertion's display blocks, not published.
      publishFrame: async () => {},
    };
  }
  get(resource: ArtemisMessageResource): ArtemisTextInsertion {
    let owner = this.owners.get(resource);
    if (!owner) {
      owner = new ArtemisTextInsertion(this.hash, this.style(resource), this.host(resource));
      this.owners.set(resource, owner);
    }
    owner.setStyle(this.style(resource));
    owner.setIndentation(
      resource.indentation ?? {pairs: new Map(), range: 0, logicalRange: false, nest: false},
    );
    owner.setWordParts(resource.wordParts ?? new Set());
    owner.setProhibitedCharacters(
      resource.prohibition?.head ?? new Set(),
      resource.prohibition?.foot ?? new Set(),
    );
    return owner;
  }
  /** The insertion of a resource without updating its style, if it has one. */
  peek(resource: ArtemisMessageResource): ArtemisTextInsertion | undefined {
    return this.owners.get(resource);
  }
  copy(old: ArtemisMessageResource, resource: ArtemisMessageResource): void {
    const owner = this.owners.get(old);
    if (owner) this.owners.set(resource, owner.copy(this.host(resource)));
  }
  release(resource: ArtemisMessageResource): void {
    this.owners.get(resource)?.close();
    this.owners.delete(resource);
  }
  entries(): [ArtemisMessageResource, ArtemisTextInsertion][] {
    return [...this.owners];
  }
  close(): void {
    for (const owner of this.owners.values()) owner.close();
    this.owners.clear();
  }
}
