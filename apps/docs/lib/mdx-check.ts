import { compile, type CompileOptions } from '@mdx-js/mdx';
import { applyMdxPreset } from 'fumadocs-mdx/config';

/**
 * Compiles one documentation page the way the site build does, so a page that
 * cannot be parsed fails a local gate instead of the release.
 *
 * The site is only built inside the docs image, which runs on release tags.
 * Without this check the first thing that ever parses a page body is that
 * build: a placeholder written as `<platform>` that a formatter reflows out of
 * its code span becomes an unclosed JSX tag, and the release dies on it.
 *
 * The options are the docs build's own preset (`applyMdxPreset`), in its
 * `runtime` form: the same remark and rehype plugins, but images stay URLs
 * instead of becoming imports, so the check needs no bundler and no files
 * under `public/`.
 */

export interface MdxProblem {
  path: string;
  line: number | null;
  column: number | null;
  message: string;
}

let presetOptions: Promise<CompileOptions> | null = null;

const docsCompileOptions = (): Promise<CompileOptions> => {
  presetOptions ??= applyMdxPreset({})('runtime') as Promise<CompileOptions>;
  return presetOptions;
};

/**
 * The page with its leading YAML front matter blanked line for line. The
 * site reads front matter separately, so the compiler must not see it; the
 * lines stay, so a reported position is still the file's own line.
 */
export const blankFrontMatter = (source: string): string => {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(source);
  if (!match) {
    return source;
  }
  return match[0].replace(/[^\n]/gu, '') + source.slice(match[0].length);
};

/** Null when the page compiles; otherwise where and why it does not. */
export const checkDocsPage = async (
  path: string,
  source: string
): Promise<MdxProblem | null> => {
  const options = await docsCompileOptions();
  try {
    await compile(
      { path, value: blankFrontMatter(source) },
      { ...options, format: path.endsWith('.md') ? 'md' : 'mdx' }
    );
    return null;
  } catch (error) {
    const place = error as {
      line?: number | null;
      column?: number | null;
      reason?: string;
    };
    return {
      path,
      line: place.line ?? null,
      column: place.column ?? null,
      message:
        place.reason ??
        (error instanceof Error ? error.message : String(error)),
    };
  }
};
