import {BlobSource} from '../core/source.js';
import {beginLocalRead} from '../core/source-activity.js';
import {readSfntFontMetadata, type SfntFontMetadata} from '../formats/sfnt.js';
import {beginRuntimeSpan} from '../platform/runtime-performance.js';
import {getRuntimeProfile} from '../platform/runtime-profile.js';
import type {
  LocalFontMetadataRequest,
  LocalFontMetadataResponse,
} from './local-font-metadata-worker.js';

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

type MetadataParser = (blob: Blob) => Promise<readonly SfntFontMetadata[]>;

const parseInThread: MetadataParser = (blob) => readSfntFontMetadata(new BlobSource(blob));

/**
 * Blob range reads and sfnt parsing for one catalog, off the main thread. Installed-font
 * Blobs come from the window-only Local Font Access API and are posted one per job, so the
 * caller's job limit still bounds live font data. A worker failure falls back to parsing
 * in-thread; per-font read and parse failures remain per-font.
 */
class MetadataWorker {
  private readonly worker: Worker;
  /** Resolves with the worker's result, or undefined when the worker itself failed. */
  private readonly pending = new Map<
    number,
    (result: LocalFontMetadataResponse | undefined) => void
  >();
  private nextId = 1;
  private failed = false;
  constructor() {
    this.worker = new Worker(new URL('./local-font-metadata-worker.js', import.meta.url), {
      type: 'module',
    });
    this.worker.onmessage = ({data}: MessageEvent<LocalFontMetadataResponse>) => {
      const resolve = this.pending.get(data.id);
      this.pending.delete(data.id);
      resolve?.(data);
    };
    this.worker.onerror = this.worker.onmessageerror = () => this.fail();
  }
  private fail(): void {
    this.failed = true;
    this.worker.terminate();
    const jobs = [...this.pending.values()];
    this.pending.clear();
    for (const resolve of jobs) resolve(undefined);
  }
  readonly parse: MetadataParser = async (blob) => {
    if (this.failed || !(blob instanceof Blob)) return parseInThread(blob);
    const id = this.nextId++,
      finished = beginLocalRead();
    let bytes = 0;
    try {
      const result = await new Promise<LocalFontMetadataResponse | undefined>((resolve) => {
        this.pending.set(id, resolve);
        this.worker.postMessage({id, blob} satisfies LocalFontMetadataRequest);
      });
      if (result === undefined) return parseInThread(blob);
      bytes = result.bytes;
      if (result.faces === null) throw new RangeError('Installed font metadata is unreadable');
      return result.faces;
    } finally {
      finished(bytes);
    }
  };
  close(): void {
    this.worker.terminate();
  }
}

async function readRecord(
  record: BrowserLocalFontRecord,
  parse: MetadataParser,
): Promise<BrowserLocalFontMetadata[]> {
  const faces: BrowserLocalFontMetadata[] = [];
  try {
    // Metadata reads cover only the header, directory and needed tables (nearby tables
    // share one read; see readSfntFontMetadata). The complete font Blob stays local to
    // this job and is not part of the returned catalog.
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
      data = await parse(blob);
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
  let metadataWorker: MetadataWorker | null = null;
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
    if (records.length !== 0 && typeof Worker !== 'undefined') {
      try {
        metadataWorker = new MetadataWorker();
      } catch {
        // Construction failures keep in-thread parsing.
      }
    }
    const parse = metadataWorker?.parse ?? parseInThread;
    if (concurrency === 1) {
      const faces: BrowserLocalFontMetadata[] = [];
      for (const record of records)
        for (const face of await readRecord(record, parse)) faces.push(face);
      return faces;
    }
    // Keep query order and each collection's face order even if reads finish
    // out of order. Limit live Blob/table-read jobs to bound memory and I/O.
    const results: BrowserLocalFontMetadata[][] = new Array(records.length);
    let next = 0;
    async function job(): Promise<void> {
      while (next < records.length) {
        const index = next++;
        results[index] = await readRecord(records[index]!, parse);
      }
    }
    await Promise.all(Array.from({length: Math.min(concurrency, records.length)}, job));
    return results.flat();
  } finally {
    metadataWorker?.close();
    finishCatalog?.({concurrency, worker: metadataWorker !== null});
  }
}
