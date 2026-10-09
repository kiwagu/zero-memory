/**
 * Ambient surface for the Bun APIs web-app.entry.ts uses. Declared locally
 * rather than pulling in `bun-types`, whose global augmentation collides with
 * `@types/node`; the same approach the repository's packages take. Extend
 * here rather than casting at the call site.
 */

declare const Bun: {
  spawn(
    command: string[],
    options: {
      env: Record<string, string | undefined>;
      stdout: 'inherit';
      stderr: 'inherit';
    }
  ): { exited: Promise<number> };
  serve(options: {
    port: number;
    idleTimeout?: number;
    fetch(request: Request): Response | Promise<Response>;
  }): unknown;
  sleep(ms: number): Promise<void>;
};

/** Bun's fetch decodes compressed bodies unless told not to. */
interface RequestInit {
  decompress?: boolean;
}
