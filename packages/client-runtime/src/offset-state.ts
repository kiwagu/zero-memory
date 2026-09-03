import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

const stateSchema = z.object({
  /** Byte offset already processed per transcript file. */
  offsets: z.record(z.string(), z.number().int().min(0)),
});
export type WatcherStateData = z.infer<typeof stateSchema>;

export const defaultStatePath = (): string =>
  join(
    process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'),
    'zero-memory',
    'watcher.json'
  );

/**
 * Persisted per-file byte offsets so a restarted watcher resumes where it
 * left off instead of re-ingesting whole transcripts (the ingest log would
 * dedupe them anyway, but re-extraction costs money).
 */
export class OffsetState {
  #data: WatcherStateData;

  constructor(private readonly path: string = defaultStatePath()) {
    this.#data = this.#load();
  }

  get(filePath: string): number {
    return this.#data.offsets[filePath] ?? 0;
  }

  set(filePath: string, offset: number): void {
    this.#data.offsets[filePath] = offset;
    this.#save();
  }

  #load(): WatcherStateData {
    try {
      const raw = readFileSync(this.path, 'utf8');
      return stateSchema.parse(JSON.parse(raw));
    } catch {
      return { offsets: {} };
    }
  }

  #save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.#data, null, 2));
  }
}
