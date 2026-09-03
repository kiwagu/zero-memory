import { defineConfig, defineDocs } from 'fumadocs-mdx/config';

// The content tree is the repository's own `docs/` folder, not a directory
// private to this app: the same markdown is read by contributors in the repo
// and served by this site.
export const docs = defineDocs({
  dir: '../../docs',
});

export default defineConfig();
