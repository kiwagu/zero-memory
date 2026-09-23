/**
 * The rows of a Supabase query, or a thrown error. A read that failed is never
 * reported as "nothing there": that would turn a transient fault into a
 * missing resource, or into a section that quietly shows empty.
 */
export function rowsOf<
  R extends { data: unknown; error: { message: string } | null },
>(result: R, what: string): R['data'] {
  if (result.error) {
    throw new Error(`${what}: ${result.error.message}`);
  }
  return result.data;
}
