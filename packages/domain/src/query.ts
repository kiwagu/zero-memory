export type QueryProps<T> = T & Partial<Query>;

/**
 * Base query: read-only request handled by a query handler.
 */
export abstract class Query {}
