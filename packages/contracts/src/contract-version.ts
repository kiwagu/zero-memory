/**
 * Version of the tool/response contract this build speaks, independent of any
 * package version. It rides the MCP handshake (see the server's `contract`
 * capability) so a client can tell what it is talking to before it calls
 * anything.
 *
 * Semantics — semver, judged from the CLIENT's side:
 * - **major** — a breaking change to a tool's input or response schema: a
 *   field removed or renamed, a type narrowed, a tool withdrawn. Anything an
 *   existing client could choke on.
 * - **minor** — an additive change: a new optional field, a new tool, a new
 *   enum member in a field the client only reads.
 * - **patch** — wording only: descriptions, instructions, documentation. No
 *   shape change at all.
 *
 * Bump this in the same commit as the change it describes, and record every
 * major/minor removal in `docs/DEPRECATIONS.md` — after the public release the
 * contract is held open by clients we do not control.
 */
export const CONTRACT_VERSION = '3.0.1';
