/**
 * A minimal flat-catalog translator shared by every catalog consumer:
 * `t(key, vars?)` looks the key up and interpolates `{name}` placeholders.
 * Returns the key itself when absent so a missing string is visible (not
 * silently blank) — the catalog is the authority.
 */
export type Translator = (
  key: string,
  vars?: Record<string, string | number>
) => string;

export function createTranslator(messages: Record<string, string>): Translator {
  return (key, vars) => {
    const template = messages[key] ?? key;
    if (!vars) {
      return template;
    }
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in vars ? String(vars[name]) : match
    );
  };
}
