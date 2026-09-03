'use client';

import * as React from 'react';

import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components/select';

/**
 * Scope administration forms. Mechanism only: labels/options arrive
 * translated, mutations are the injected callbacks, the caller owns
 * pending/error state.
 */

interface CreateScopeFormLabels {
  placeholder: string;
  submit: string;
  submitPending: string;
  hint: string;
}

function CreateScopeForm({
  labels,
  pending,
  error,
  onCreate,
}: {
  labels: CreateScopeFormLabels;
  pending: boolean;
  error: string | null;
  onCreate: (scope: string) => void;
}) {
  const [scope, setScope] = React.useState('');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onCreate(scope.trim());
        setScope('');
      }}
      className="space-y-2"
    >
      <div className="flex flex-wrap gap-2">
        <Input
          type="text"
          required
          value={scope}
          onChange={(event) => setScope(event.target.value)}
          placeholder={labels.placeholder}
          className="w-64"
        />
        <Button type="submit" size="sm" disabled={pending || !scope.trim()}>
          {pending ? labels.submitPending : labels.submit}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{labels.hint}</p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </form>
  );
}

interface AddMemberFormLabels {
  emailPlaceholder: string;
  submit: string;
  submitPending: string;
}

interface RoleOption {
  value: string;
  label: string;
}

function AddMemberForm({
  labels,
  roles,
  pending,
  error,
  onAdd,
}: {
  labels: AddMemberFormLabels;
  roles: RoleOption[];
  pending: boolean;
  error: string | null;
  onAdd: (email: string, role: string) => void;
}) {
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState(roles[0]?.value ?? '');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onAdd(email.trim(), role);
        setEmail('');
      }}
      className="space-y-2"
    >
      <div className="flex flex-wrap gap-2">
        <Input
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder={labels.emailPlaceholder}
          className="w-56"
        />
        <Select
          value={role}
          // Items map so Base UI's Select.Value shows the translated label,
          // not the raw role slug.
          items={Object.fromEntries(
            roles.map((option) => [option.value, option.label])
          )}
          onValueChange={(next) => setRole(String(next))}
        >
          <SelectTrigger size="sm" className="min-w-28">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {roles.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={pending || !email.trim()}
        >
          {pending ? labels.submitPending : labels.submit}
        </Button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </form>
  );
}

export {
  AddMemberForm,
  CreateScopeForm,
  type AddMemberFormLabels,
  type CreateScopeFormLabels,
  type RoleOption,
};
