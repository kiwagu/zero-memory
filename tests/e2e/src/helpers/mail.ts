/**
 * Reads mail captured by the stand's local catcher (started by `[local_smtp]` in
 * tests/e2e/supabase/config.toml). This is the only place in the suite that walks
 * the authentication mail path — every other spec provisions users through the
 * admin API precisely to avoid it, which is why nothing noticed that mail was
 * never configured.
 *
 * The catcher is **Mailpit** (`supabase/mailpit`), not Inbucket: the Supabase CLI
 * swapped it, and both the CLI docs and the older `[inbucket]` config name still
 * say otherwise. Its API is message-centric rather than mailbox-centric — there
 * are no `/api/v1/mailbox/<name>` routes, so a wrong guess here answers 404/405
 * rather than failing obviously.
 */

const catcherUrl = (
  process.env.E2E_MAIL_CATCHER_URL ?? 'http://127.0.0.1:55334'
).replace(/\/$/, '');

type MailpitSummary = {
  ID: string;
  Subject: string;
  Created: string;
};

type MailpitMessage = {
  Subject?: string;
  HTML?: string;
  Text?: string;
};

type MailMessage = {
  subject: string;
  html: string;
  text: string;
};

const request = async (path: string, init?: RequestInit): Promise<Response> => {
  const response = await fetch(`${catcherUrl}${path}`, init);
  if (!response.ok) {
    throw new Error(
      `Mail catcher ${init?.method ?? 'GET'} ${path} failed: ${response.status} ${response.statusText}`
    );
  }
  return response;
};

/** Newest first, as Mailpit returns search results. */
const searchTo = async (email: string): Promise<MailpitSummary[]> => {
  const response = await request(
    `/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`
  );
  const body = (await response.json()) as { messages?: MailpitSummary[] };
  return body.messages ?? [];
};

/**
 * Drops everything already addressed to this recipient so a spec asserts on the
 * mail IT caused. Without it a re-run reads the previous run's message and passes
 * even when nothing was sent.
 */
export const purgeMailbox = async (email: string): Promise<void> => {
  const ids = (await searchTo(email)).map((message) => message.ID);
  if (ids.length === 0) {
    return;
  }
  await request('/api/v1/messages', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ IDs: ids }),
  });
};

export const listMailbox = async (email: string): Promise<MailpitSummary[]> =>
  searchTo(email);

/**
 * Waits for a message to land and returns it. Mail is sent by Auth in the
 * background, so polling is the honest model — there is no request to await.
 */
export const waitForMail = async (
  email: string,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<MailMessage> => {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const [newest] = await searchTo(email);
    if (newest) {
      const response = await request(`/api/v1/message/${newest.ID}`);
      const message = (await response.json()) as MailpitMessage;
      return {
        subject: message.Subject ?? newest.Subject,
        html: message.HTML ?? '',
        text: message.Text ?? '',
      };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `No mail for ${email} within ${timeoutMs}ms (catcher: ${catcherUrl}). ` +
          'Is [local_smtp] enabled in the stand config?'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};

/**
 * The action link, taken from the HTML the recipient actually gets. Asserting
 * through this (rather than building the link from a token) is what makes the
 * spec cover the template: a template whose `{{ .ConfirmationURL }}` failed to
 * substitute has no link to find.
 */
export const extractActionLink = (html: string): string => {
  const match = html.match(/href="(https?:\/\/[^"]*\/auth\/v1\/verify[^"]*)"/);
  if (!match?.[1]) {
    throw new Error('No Auth verification link found in the message HTML');
  }
  return match[1].replaceAll('&amp;', '&');
};
