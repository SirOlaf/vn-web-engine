import {BlobSource} from '../core/source.js';
import {readSfntFontMetadata, type SfntFontMetadata} from '../formats/sfnt.js';

export interface BrowserLocalFontRecord {
  readonly family: string;
  readonly fullName: string;
  readonly postscriptName: string;
  blob(): Promise<Blob>;
}

export interface BrowserLocalFontHost {
  queryLocalFonts?: () => Promise<readonly BrowserLocalFontRecord[]>;
}

export interface BrowserLocalFontMetadata {
  readonly family: string;
  readonly fullName: string;
  readonly postscriptName: string;
  readonly data: SfntFontMetadata;
}

/** Enumerate installed font metadata without retaining glyph data or rebuilding collection faces. */
export async function readBrowserLocalFontMetadata(
  host: BrowserLocalFontHost = globalThis as BrowserLocalFontHost,
): Promise<readonly BrowserLocalFontMetadata[]> {
  if (!host.queryLocalFonts) return [];
  let records: readonly BrowserLocalFontRecord[];
  try {
    records = await host.queryLocalFonts();
  } catch {
    return [];
  }
  const faces: BrowserLocalFontMetadata[] = [];
  for (const record of records) {
    try {
      // BlobSource reads only requested table ranges. The complete font Blob
      // stays local to this iteration and is not part of the returned catalog.
      const data = await readSfntFontMetadata(new BlobSource(await record.blob()));
      for (const face of data)
        faces.push({
          data: face,
          family: record.family,
          fullName: record.fullName,
          postscriptName: record.postscriptName,
        });
    } catch {
      // Denied or unreadable installed faces are unavailable to this host.
    }
  }
  return faces;
}
