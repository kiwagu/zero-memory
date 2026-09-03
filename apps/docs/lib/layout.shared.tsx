import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: 'zero-memory',
    },
    links: [
      {
        text: 'Documentation',
        url: '/docs',
        active: 'nested-url',
      },
      // `/upload` is deliberately absent: the page still exists (and stays off
      // unless the operator sets its token), but it is an authoring tool, not
      // something a reader of the documentation should be offered.
    ],
  };
}
