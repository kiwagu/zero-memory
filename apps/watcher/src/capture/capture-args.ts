import { memoryKindSchema, type MemoryKind } from '@workspace/contracts';

/**
 * Argument parsing for the quick-capture CLI (`zm "fact"` /
 * `zero-memory-watcher capture "fact"`). Pure and unit-tested; the runner
 * stays a thin I/O shell. The CLI is TRANSPORT only — content rides the full
 * standard write path (content guard, embedder, canonicalization) server-side.
 */

export interface CaptureArgs {
  /** The fact to store (positional args joined with a space). */
  content: string;
  /** Explicit kind (--kind / --task sugar); server defaults to fact. */
  kind?: MemoryKind;
  /** Explicit target scope (--scope); default is the project by cwd. */
  scope?: string;
  /** Target the local e2e sandbox instead of the real server (--e2e). */
  e2e: boolean;
}

export const CAPTURE_USAGE =
  'usage: zm [--task | --kind <kind>] [--scope <scope>] [--e2e] "<fact>"\n' +
  '       (zm is the deploy alias for: zero-memory-watcher capture ...)\n' +
  `  --task           store as an open loop (kind=task) — it surfaces in\n` +
  '                   every briefing until closed with close_loop\n' +
  `  --kind <kind>    one of: ${memoryKindSchema.options.join(', ')}\n` +
  '  --scope <scope>  exact scope path, or "core" for a portable fact;\n' +
  '                   default: the project resolved from the current directory\n' +
  '  --e2e            write to the local e2e sandbox (separate login)';

/** Parsed args or a user-facing error line (never throws). */
export const parseCaptureArgs = (
  argv: readonly string[]
): CaptureArgs | { error: string } => {
  const positionals: string[] = [];
  let kind: string | undefined;
  let task = false;
  let scope: string | undefined;
  let e2e = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--task') {
      task = true;
    } else if (arg === '--kind') {
      kind = argv[i + 1];
      i += 1;
      if (kind === undefined) {
        return { error: '--kind needs a value' };
      }
    } else if (arg === '--scope') {
      scope = argv[i + 1];
      i += 1;
      if (scope === undefined) {
        return { error: '--scope needs a value' };
      }
    } else if (arg === '--e2e') {
      e2e = true;
    } else if (arg.startsWith('--')) {
      return { error: `unknown flag ${arg}` };
    } else {
      positionals.push(arg);
    }
  }

  if (task && kind !== undefined) {
    return { error: '--task and --kind are mutually exclusive' };
  }
  if (kind !== undefined) {
    const parsed = memoryKindSchema.safeParse(kind);
    if (!parsed.success) {
      return {
        error:
          `unknown kind "${kind}" — expected one of: ` +
          memoryKindSchema.options.join(', '),
      };
    }
  }

  const content = positionals.join(' ').trim();
  if (content.length === 0) {
    return { error: 'nothing to capture — pass the fact as an argument' };
  }

  return {
    content,
    ...(task
      ? { kind: 'task' as MemoryKind }
      : kind !== undefined
        ? { kind: kind as MemoryKind }
        : {}),
    ...(scope !== undefined ? { scope } : {}),
    e2e,
  };
};
