import {BlobSource} from '../core/source.js';
import {readSfntFontMetadata, type SfntFontMetadata} from '../formats/sfnt.js';
import {beginRuntimeSpan} from '../platform/runtime-performance.js';
import {getRuntimeProfile} from '../platform/runtime-profile.js';

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

async function readRecord(record: BrowserLocalFontRecord): Promise<BrowserLocalFontMetadata[]> {
  const faces: BrowserLocalFontMetadata[] = [];
  try {
    // BlobSource reads only requested table ranges. The complete font Blob
    // stays local to this job and is not part of the returned catalog.
    const finishBlob = beginRuntimeSpan('text.font.local-blob');
    let blob: Blob;
    try {
      blob = await record.blob();
    } finally {
      finishBlob?.();
    }
    const finishMetadata = beginRuntimeSpan('text.font.local-metadata');
    let data: readonly SfntFontMetadata[];
    try {
      data = await readSfntFontMetadata(new BlobSource(blob));
    } finally {
      finishMetadata?.();
    }
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
  return faces;
}

/** Enumerate installed font metadata without retaining glyph data or rebuilding collection faces. */
export async function readBrowserLocalFontMetadata(
  host: BrowserLocalFontHost = globalThis as BrowserLocalFontHost,
): Promise<readonly BrowserLocalFontMetadata[]> {
  const concurrency = getRuntimeProfile() === 'browser-optimized' ? 4 : 1;
  const finishCatalog = beginRuntimeSpan('text.font.local-catalog');
  try {
    if (!host.queryLocalFonts) return [];
    let records: readonly BrowserLocalFontRecord[];
    try {
      const finishQuery = beginRuntimeSpan('text.font.local-query');
      try {
        records = await host.queryLocalFonts();
      } finally {
        finishQuery?.();
      }
    } catch {
      return [];
    }
    if (concurrency === 1) {
      const faces: BrowserLocalFontMetadata[] = [];
      for (const record of records) for (const face of await readRecord(record)) faces.push(face);
      return faces;
    }
    // Keep query order and each collection's face order even if reads finish
    // out of order. Limit live Blob/table-read jobs to bound memory and I/O.
    const results: BrowserLocalFontMetadata[][] = new Array(records.length);
    let next = 0;
    async function worker(): Promise<void> {
      while (next < records.length) {
        const index = next++;
        results[index] = await readRecord(records[index]!);
      }
    }
    await Promise.all(Array.from({length: Math.min(concurrency, records.length)}, worker));
    return results.flat();
  } finally {
    finishCatalog?.({concurrency});
  }
}
