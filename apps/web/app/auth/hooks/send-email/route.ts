import { answerAuthMailHook } from '@workspace/email';

import { authMailHookFromEnv } from '@/lib/auth-mail.hook';

/**
 * Supabase Auth's send-email hook: with the hook enabled on the Supabase
 * project, Auth posts each authentication mail here instead of sending it
 * over SMTP, and this route renders it from the product's own templates and
 * sends it through the configured transport. Without ZM_AUTH_HOOK_SECRET the
 * route answers 404, as if it did not exist.
 */
export async function POST(request: Request): Promise<Response> {
  const config = authMailHookFromEnv();
  if (!config) {
    return Response.json(
      {
        error: { code: 'not_found', message: 'No route matches this request.' },
      },
      { status: 404 }
    );
  }
  const answer = await answerAuthMailHook({
    // The signature covers the body byte for byte, so it is read raw.
    body: await request.text(),
    headers: request.headers,
    secret: config.secret,
    authUrl: config.authUrl,
    sender: config.sender,
  });
  return Response.json(answer.body, { status: answer.status });
}
