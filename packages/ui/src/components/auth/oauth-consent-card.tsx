'use client';

import * as React from 'react';

import { Button } from '@workspace/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card';

/**
 * One area of what the client may do as the person, in plain words.
 * `destructive` marks an area whose actions cannot be taken back.
 */
interface OAuthConsentArea {
  id: string;
  title: string;
  body: string;
  destructive?: boolean;
}

/** Translated copy. `{client}`, `{host}` and `{account}` are placeholders. */
interface OAuthConsentLabels {
  title: string;
  unnamedClient: string;
  description: string;
  /** Everything an allowed client can reach; the screen hides none of it. */
  areas: OAuthConsentArea[];
  returnTo: string;
  signedInAs: string;
  /** The way out for someone signed in with the wrong account. */
  signOut: string;
  allow: string;
  allowPending: string;
  deny: string;
}

/** Long enough for any real client's name, short enough not to dominate. */
const MAX_CLIENT_NAME = 80;

const displayName = (name: string): string =>
  name.length > MAX_CLIENT_NAME
    ? `${name.slice(0, MAX_CLIENT_NAME - 1)}…`
    : name;

/**
 * Fills one placeholder of a translated template with a node, keeping the
 * template's word order, so every language reads as a sentence.
 */
function Fill({
  template,
  placeholder,
  children,
}: {
  template: string;
  placeholder: string;
  children: React.ReactNode;
}) {
  const [before, ...rest] = template.split(placeholder);
  return (
    <>
      {before}
      {rest.length > 0 ? children : null}
      {rest.join(placeholder)}
    </>
  );
}

/**
 * OAuthConsentCard — the screen where a person lets an agent's client into
 * their memory, or refuses. The client's name is whatever it registered
 * itself as, so it is shown as plain text (React escapes it) and cut short;
 * where the browser goes afterwards is named too, which is what tells a
 * genuine local client from a look-alike. Mechanism only: copy arrives
 * translated and both choices are injected.
 */
function OAuthConsentCard({
  labels,
  clientName,
  returnHost,
  account,
  pending,
  error,
  onAllow,
  onDeny,
  onSignOut,
}: {
  labels: OAuthConsentLabels;
  clientName: string | null;
  returnHost: string;
  account: string;
  pending: 'allow' | 'deny' | null;
  error: string | null;
  onAllow: () => void;
  onDeny: () => void;
  onSignOut: () => void;
}) {
  const busy = pending !== null;
  return (
    <Card className="w-full max-w-md" data-testid="oauth-consent">
      <CardHeader>
        <CardTitle className="break-words">
          <Fill template={labels.title} placeholder="{client}">
            <strong data-testid="oauth-consent-client">
              {clientName === null
                ? labels.unnamedClient
                : displayName(clientName)}
            </strong>
          </Fill>
        </CardTitle>
        <CardDescription>{labels.description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="space-y-2 text-sm">
          {labels.areas.map((area) => (
            <li key={area.id} data-testid={`oauth-consent-area-${area.id}`}>
              <span
                className={
                  area.destructive
                    ? 'text-destructive font-medium'
                    : 'font-medium'
                }
              >
                {area.title}
              </span>
              <span className="text-muted-foreground block">{area.body}</span>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground text-sm">
          <Fill template={labels.returnTo} placeholder="{host}">
            <span
              data-testid="oauth-consent-return-host"
              className="text-foreground font-mono break-all"
            >
              {returnHost}
            </span>
          </Fill>
        </p>
        {error ? (
          <p
            data-testid="oauth-consent-error"
            role="alert"
            className="text-destructive text-sm"
          >
            {error}
          </p>
        ) : null}
      </CardContent>
      <CardFooter className="flex-col gap-3">
        <div className="flex w-full gap-2">
          <Button
            type="button"
            variant="outline"
            className="flex-1"
            data-testid="oauth-consent-deny"
            disabled={busy}
            onClick={onDeny}
          >
            {labels.deny}
          </Button>
          <Button
            type="button"
            className="flex-1"
            data-testid="oauth-consent-allow"
            disabled={busy}
            onClick={onAllow}
          >
            {pending === 'allow' ? labels.allowPending : labels.allow}
          </Button>
        </div>
        <p className="text-muted-foreground text-center text-sm">
          <Fill template={labels.signedInAs} placeholder="{account}">
            <span data-testid="oauth-consent-account">{account}</span>
          </Fill>{' '}
          <Button
            type="button"
            variant="link"
            size="sm"
            className="text-muted-foreground h-auto p-0"
            data-testid="oauth-consent-sign-out"
            disabled={busy}
            onClick={onSignOut}
          >
            {labels.signOut}
          </Button>
        </p>
      </CardFooter>
    </Card>
  );
}

export { OAuthConsentCard, type OAuthConsentArea, type OAuthConsentLabels };
