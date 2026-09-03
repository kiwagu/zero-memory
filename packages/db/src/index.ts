export type {
  Database,
  Json,
  Tables,
  TablesInsert,
  TablesUpdate,
} from './database.types.js';

export * from './ownership-map.js';
export * from './rule-delivery.js';

import type { Database } from './database.types.js';

/** Row/insert/update aliases for the tables the app touches. */
export type MemoryRow = Database['public']['Tables']['memories']['Row'];
export type MemoryInsert = Database['public']['Tables']['memories']['Insert'];
export type MemoryUpdate = Database['public']['Tables']['memories']['Update'];
export type ScopeMemberRow =
  Database['public']['Tables']['scope_members']['Row'];
export type EntityRow = Database['public']['Tables']['entities']['Row'];
export type EntityInsert = Database['public']['Tables']['entities']['Insert'];
export type MemoryEntityRow =
  Database['public']['Tables']['memory_entities']['Row'];
export type EdgeRow = Database['public']['Tables']['edges']['Row'];
export type EdgeInsert = Database['public']['Tables']['edges']['Insert'];
export type MemoryLinkRow = Database['public']['Tables']['memory_links']['Row'];

/** RPC result rows. */
export type SearchMemoriesRow =
  Database['public']['Functions']['search_memories']['Returns'][number];
export type FindSimilarMemoryRow =
  Database['public']['Functions']['find_similar_memory']['Returns'][number];
export type FindSimilarEntityRow =
  Database['public']['Functions']['find_similar_entity']['Returns'][number];
export type TraverseEntitiesRow =
  Database['public']['Functions']['traverse_entities']['Returns'][number];
