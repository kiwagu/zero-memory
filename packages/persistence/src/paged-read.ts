/**
 * Paginated reads — the standard way to fetch a whole table through PostgREST.
 *
 * WHY THIS EXISTS, and it is worth stating because the failure is silent:
 * PostgREST caps every response at its `max-rows` setting (1000 by default).
 * A plain `.select()` over a growing table therefore returns the first page and
 * NO error, no warning, no truncation flag. The caller gets an array that looks
 * complete, iterates it happily, and reports success — while the rest of the
 * table was never read. Two shipped code paths were caught doing exactly this
 * within two days of each other: a backlog sweep that walked 1000 of 2118 rows
 * and announced "corpus exhausted", and the entity-merge service, which had
 * been silently merging only the first thousand nodes of a graph for as long as
 * the graph had more than a thousand.
 *
 * The tell is a round number in a result summary. If a job reports scanning
 * exactly 1000 of anything, it did not scan anything — it hit the cap.
 *
 * TWO RULES THIS ENCODES:
 *  1. Ask for pages until one comes back EMPTY. Never treat a SHORT page as the
 *     end: a short page is also what a server-side cap smaller than your page
 *     size looks like, and that ambiguity is the whole bug.
 *  2. Advance by the rows actually RECEIVED, never by the page size asked for.
 *     If the server's cap is below your page size, striding by the request size
 *     silently skips everything between the two — the same class of bug one
 *     level down, and this helper's own first draft had it until a test caught
 *     it.
 *  3. Build a FRESH query per page. A PostgREST query builder is single-use —
 *     awaiting it twice replays the same request — so the caller passes a
 *     factory, not a builder.
 *
 * Usage:
 *   const rows = await readAllPages((from, to) =>
 *     client.from('entities').select('id, name, scope').range(from, to)
 *   );
 *
 * Add ORDER BY in the factory when the rows feed anything order-dependent:
 * without it Postgres may return a row on two pages, or on none, as concurrent
 * writes move it between them.
 */

/** What a PostgREST query resolves to, narrowed to what paging needs. */
interface PageResult<TRow> {
  data: TRow[] | null;
  error: { message: string } | null;
}

/** Rows per request. Below PostgREST's default cap so a full page is a real page. */
const DEFAULT_PAGE_SIZE = 500;

/**
 * Hard stop on total rows, so a runaway loop cannot exhaust memory if a
 * mis-built factory keeps returning the same page. Generous enough that no
 * legitimate table in this system reaches it quietly.
 */
const DEFAULT_MAX_ROWS = 200_000;

export interface PagedReadOptions {
  /** Rows per request (default 500). */
  pageSize?: number;
  /** Safety ceiling on rows collected before the read gives up (default 200k). */
  maxRows?: number;
  /** Named in the error when the ceiling is hit, so the log says which read. */
  label?: string;
}

/**
 * Reads every row a query matches, one page at a time.
 *
 * `page` is called with an inclusive row range and must return a NEW query each
 * time. Throws on the first page error, and throws rather than truncating if
 * `maxRows` is reached — a silent short read is the thing this exists to stop,
 * so it must never introduce one of its own.
 */
export async function readAllPages<TRow>(
  page: (from: number, to: number) => PromiseLike<PageResult<TRow>>,
  options: PagedReadOptions = {}
): Promise<TRow[]> {
  const pageSize = Math.max(1, options.pageSize ?? DEFAULT_PAGE_SIZE);
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  const label = options.label ?? 'paged read';

  const rows: TRow[] = [];
  for (let offset = 0; ;) {
    const { data, error } = await page(offset, offset + pageSize - 1);
    if (error) {
      throw new Error(`${label} failed at offset ${offset}: ${error.message}`);
    }
    const batch = data ?? [];
    rows.push(...batch);
    // Advance by what arrived, not by what was asked for (rule 2).
    offset += batch.length;
    // An EMPTY page is the end. A short one is not: it is also what a
    // server-side cap below our page size looks like.
    if (batch.length === 0) {
      return rows;
    }
    if (rows.length >= maxRows) {
      throw new Error(
        `${label} exceeded ${maxRows} rows — refusing to return a truncated read`
      );
    }
  }
}
