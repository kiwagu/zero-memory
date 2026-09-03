'use client';

import * as React from 'react';

import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { Button } from '@workspace/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@workspace/ui/components/card';
import { Input } from '@workspace/ui/components/input';
import { Label } from '@workspace/ui/components/label';

export interface ProfileLabels {
  title: string;
  description: string;
  emailLabel: string;
  nameLabel: string;
  namePlaceholder: string;
  nameHint: string;
  save: string;
  saving: string;
  saved: string;
}

export type ProfilePanelProps = {
  labels: ProfileLabels;
  /** The account's address — shown as read-only context, never editable here. */
  email: string;
  /** The stored display name, empty when the account never set one. */
  name: string;
  onSave: (
    name: string
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
};

/**
 * The account's own profile: the address it signs in with, and the name the
 * dashboard shows in place of that address.
 *
 * Deliberately narrow — an account identity screen, not a settings dumping
 * ground. The address stays read-only because changing it is an auth flow
 * (re-confirmation), not a profile edit.
 */
function ProfilePanel({ labels, email, name, onSave }: ProfilePanelProps) {
  const [value, setValue] = React.useState(name);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setSaved(false);
    const result = await onSave(value);
    setPending(false);
    if (result.ok) {
      setSaved(true);
      return;
    }
    setError(result.error);
  }

  return (
    <Card data-testid="settings-profile">
      <CardHeader>
        <CardTitle>{labels.title}</CardTitle>
        <CardDescription>{labels.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="profile-email">{labels.emailLabel}</Label>
            <Input
              id="profile-email"
              value={email}
              readOnly
              disabled
              data-testid="profile-email"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="profile-name">{labels.nameLabel}</Label>
            <Input
              id="profile-name"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setSaved(false);
              }}
              placeholder={labels.namePlaceholder}
              maxLength={NAME_MAX_LENGTH}
              data-testid="profile-name"
            />
            <p className="text-muted-foreground text-sm">{labels.nameHint}</p>
          </div>

          <Button
            type="submit"
            disabled={pending}
            className="self-start"
            data-testid="profile-save"
          >
            {pending ? labels.saving : labels.save}
          </Button>

          {saved && !error ? (
            <Alert data-testid="profile-saved">
              <AlertDescription>{labels.saved}</AlertDescription>
            </Alert>
          ) : null}

          {error ? (
            <Alert variant="destructive" data-testid="profile-error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Cap on the stored name. Long enough for a real name, short enough that the
 * header cannot be pushed around by it.
 */
const NAME_MAX_LENGTH = 60;

export { ProfilePanel, NAME_MAX_LENGTH };
