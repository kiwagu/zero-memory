/**
 * Lint the tracked environment templates for values that not every consumer
 * reads the same way.
 *
 * An env file looks like data, but it has no single parser: systemd's
 * EnvironmentFile= takes the right-hand side literally, a shell `source`
 * word-splits it, docker compose interpolates `$`, and Bun expands `$VAR`
 * even inside single quotes. A value that is fine for the consumer you were
 * thinking about silently breaks for the one you were not — and it breaks
 * later, for an operator running something by hand, with an error that never
 * names the file. This has bitten twice in this repository's history, both
 * times through an unquoted value with a space that the example itself
 * taught.
 *
 * Rules, deliberately few:
 *   1. a value containing whitespace must be double-quoted — systemd strips
 *      the quotes, a shell honours them, so the quoted form works everywhere;
 *   2. a quoted value must close its quote;
 *   3. a bare `$` is flagged: compose wants `$$`, a shell wants `\$`, Bun
 *      expands it regardless of quoting — there is no spelling that all
 *      consumers read alike, so the template should not contain one;
 *   4. every non-comment line must parse as KEY=VALUE at all.
 *
 * Runs on tracked *.env / *.env.example files only, so private local env
 * files are never read. Wired into the root `check` gate and the pre-commit
 * hook; exits non-zero with one line per finding.
 */

const list = Bun.spawnSync(['git', 'ls-files']);
if (list.exitCode !== 0) {
  console.error('check-env-templates: git ls-files failed');
  process.exit(2);
}

const files = list.stdout
  .toString()
  .split('\n')
  .filter((path) => /(^|\/)[^/]*\.env(\.example)?$/.test(path));

const keyValue = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
const findings: string[] = [];

for (const file of files) {
  const text = await Bun.file(file).text();
  text.split('\n').forEach((line, index) => {
    const at = `${file}:${index + 1}`;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;

    const match = keyValue.exec(line);
    if (!match) {
      findings.push(
        `${at}: not a KEY=VALUE line — no consumer parses this the same way`
      );
      return;
    }

    // Both groups in the pattern are mandatory, so a successful match always
    // carries them; the index signature cannot express that, and defaulting is
    // honest here — an empty capture really is the empty string.
    const key = match[1] ?? '';
    const value = match[2] ?? '';
    const quote =
      value.startsWith('"') || value.startsWith("'") ? value[0] : '';
    if (quote) {
      if (value.length < 2 || !value.endsWith(quote)) {
        findings.push(`${at}: ${key} opens a quote it never closes`);
      }
    } else if (/\s/.test(value.trimEnd()) || value !== value.trimEnd()) {
      findings.push(
        `${at}: ${key} has unquoted whitespace — sourcing this in a shell executes part of the value`
      );
    }

    if (/\$(?!\$)/.test(value)) {
      findings.push(
        `${at}: ${key} contains a bare $ — compose, shells and Bun each read it differently; avoid $ here`
      );
    }
  });
}

if (findings.length > 0) {
  for (const finding of findings) console.error(finding);
  console.error(
    `check-env-templates: ${findings.length} finding(s) in ${files.length} file(s)`
  );
  process.exit(1);
}
console.log(`check-env-templates: ok (${files.length} template(s))`);
