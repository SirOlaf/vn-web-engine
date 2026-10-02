import type {Component} from 'svelte';

/** Players the library offers: an engine for all of its titles, or one title. */
export type PlayerId = 'buriko' | 'chaos-head-noah' | 'rscript';

export interface PlayerEntry {
  readonly id: PlayerId;
  /** The player's name, shown on its card and page. */
  readonly title: string;
  /** Short engine tag. */
  readonly engine: string;
  /** What it plays: the supported titles of an engine player, or the title's engine. */
  readonly summary: string;
  readonly initials: string;
  /** Card artwork: an engine player or a single title. */
  readonly art: 'engine' | 'title';
  readonly route: string;
  readonly explorerRoute: string | null;
  /** Key of the remembered folder and the browser copy of the installation. */
  readonly installationKey: string;
  /** What a browser copy of the installation holds, e.g. "game archives". */
  readonly installationFiles: string;
  /** The player's save file controls, loaded on demand. */
  saveFiles(): Promise<{default: Component<{runtime?: boolean; heading?: boolean}>}>;
}

export const PLAYERS: readonly PlayerEntry[] = [
  {
    id: 'buriko',
    title: 'BGI / Ethornell',
    engine: 'BURIKO',
    summary: 'Aokana · 穢翼のユースティア · Jewelry Hearts Academia · Subarashiki Hibi',
    initials: 'BG',
    art: 'engine',
    route: './buriko.html',
    explorerRoute: './buriko-assets.html',
    installationKey: 'buriko',
    installationFiles: 'game files',
    saveFiles: () => import('./buriko/SaveFiles.svelte'),
  },
  {
    id: 'chaos-head-noah',
    title: 'CHAOS;HEAD NOAH',
    engine: 'MAGES',
    summary: 'MAGES engine',
    initials: 'CH',
    art: 'title',
    route: './noah.html',
    explorerRoute: './assets.html',
    installationKey: 'chaos-head-noah-gog',
    installationFiles: 'game archives',
    saveFiles: () => import('./chaos-head-noah/SaveFiles.svelte'),
  },
  {
    id: 'rscript',
    title: 'codeX RScript',
    engine: 'RSCRIPT',
    summary: 'Fairytale Requiem · Symphony · Encore · Albatross Koukairoku',
    initials: 'RS',
    art: 'engine',
    route: './rscript.html',
    explorerRoute: null,
    installationKey: 'rscript',
    installationFiles: 'game files',
    saveFiles: () => import('./rscript/SaveFiles.svelte'),
  },
];

export function playerEntry(id: PlayerId): PlayerEntry {
  const entry = PLAYERS.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Unknown player ${id}`);
  return entry;
}
