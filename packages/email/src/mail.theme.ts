/**
 * Mail design tokens. Literal hex values on purpose: email clients do not
 * resolve CSS custom properties or `oklch()`, so the dashboard's token values
 * are mirrored here as their sRGB equivalents rather than imported. The
 * dashboard palette is neutral (zero chroma), which is what makes the mirror
 * exact enough to keep both surfaces looking like one product.
 *
 * Light only: a mail client's dark mode is not something a static template can
 * negotiate, and a hand-rolled `prefers-color-scheme` block is ignored or
 * mangled by enough clients to be a liability.
 */
export const mailTheme = {
  color: {
    background: '#ffffff',
    surface: '#fafafa',
    foreground: '#252525',
    muted: '#737373',
    border: '#e5e5e5',
    button: '#343434',
    buttonForeground: '#fafafa',
  },
  font: {
    body: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
    mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
  },
  size: {
    container: '520px',
  },
} as const;

export type MailTheme = typeof mailTheme;
