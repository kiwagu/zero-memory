/**
 * Minimal, fully self-contained login page for GET/POST /oauth/authorize.
 * No external assets (the page must work behind strict CSPs and offline);
 * the validated OAuth parameters ride along as hidden form fields.
 */

export const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

export interface LoginPageParams {
  /** Client display name shown in the consent line. */
  clientName: string;
  /** Validated OAuth params re-submitted as hidden fields. */
  hiddenFields: Record<string, string>;
  /** Error line rendered after a failed sign-in attempt. */
  errorMessage?: string;
}

export const renderLoginPage = (params: LoginPageParams): string => {
  const hidden = Object.entries(params.hiddenFields)
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`
    )
    .join('\n      ');
  const error = params.errorMessage
    ? `<p class="error" role="alert">${escapeHtml(params.errorMessage)}</p>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sign in — zero-memory</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #f5f5f4; margin: 0;
           display: flex; min-height: 100vh; align-items: center; justify-content: center; }
    main { background: #fff; border: 1px solid #e7e5e4; border-radius: 8px;
           padding: 2rem; width: 100%; max-width: 22rem; }
    h1 { font-size: 1.1rem; margin: 0 0 0.25rem; }
    p { color: #57534e; font-size: 0.9rem; margin: 0 0 1.25rem; }
    label { display: block; font-size: 0.85rem; margin: 0.75rem 0 0.25rem; }
    input[type=email], input[type=password] { width: 100%; box-sizing: border-box;
           padding: 0.5rem; border: 1px solid #d6d3d1; border-radius: 6px; }
    button { margin-top: 1.25rem; width: 100%; padding: 0.6rem; border: 0;
           border-radius: 6px; background: #1c1917; color: #fff; cursor: pointer; }
    .error { color: #b91c1c; margin: 0.75rem 0 0; }
  </style>
</head>
<body>
  <main>
    <h1>zero-memory</h1>
    <p><strong>${escapeHtml(params.clientName)}</strong> is requesting access to your memory.</p>
    <form method="post" action="">
      ${hidden}
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" required autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      ${error}
      <button type="submit">Sign in &amp; authorize</button>
    </form>
  </main>
</body>
</html>`;
};
