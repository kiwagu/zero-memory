import { injectContext, type IContext } from '@workspace/context';
import {
  type ExportedMemory,
  exportedMemorySchema,
} from '@workspace/contracts';
import { singleton } from '@workspace/di';
import { type IMemoryExportReader } from '@workspace/memory';

import { createUserClient, type Client } from '../supabase.client.js';

/** The render-relevant columns, matching {@link exportedMemorySchema}. */
const EXPORT_COLUMNS =
  'id, content, content_original, content_lang, kind, scope, visibility, ' +
  'author_kind, agent_name, source, superseded_by, invalidated_at, created_at';

/** Supabase's hard cap per select; the reader pages under it. */
const PAGE_SIZE = 1000;

/**
 * Supabase adapter for the export read port. Runs as the current user (JWT from
 * the execution context), so RLS decides what is exported — the caller's own
 * memories plus anything shared into their scopes, and nothing else.
 */
@singleton()
export class SupabaseMemoryExportReader implements IMemoryExportReader {
  constructor(
    @injectContext()
    private readonly context: IContext
  ) {}

  async listAll(scopes?: string[]): Promise<ExportedMemory[]> {
    const items: ExportedMemory[] = [];
    for (let page = 0; ; page += 1) {
      const from = page * PAGE_SIZE;
      let query = this.#client()
        .from('memories')
        .select(EXPORT_COLUMNS)
        // Stable order so the exported tree (and its git diff) is deterministic.
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (scopes && scopes.length > 0) {
        query = query.in('scope', scopes);
      }
      const { data, error } = await query;
      if (error) {
        throw new Error(`Failed to read memories for export: ${error.message}`);
      }
      const rows = data ?? [];
      for (const row of rows) {
        items.push(exportedMemorySchema.parse(row));
      }
      if (rows.length < PAGE_SIZE) {
        break;
      }
    }
    return items;
  }

  async findById(id: string): Promise<ExportedMemory | null> {
    const { data, error } = await this.#client()
      .from('memories')
      .select(EXPORT_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to read memory ${id}: ${error.message}`);
    }
    return data ? exportedMemorySchema.parse(data) : null;
  }

  #client(): Client {
    const accessToken = this.context.getAccessToken();
    if (!accessToken) {
      throw new Error('No access token in the execution context.');
    }
    return createUserClient(accessToken);
  }
}
