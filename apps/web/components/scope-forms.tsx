'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  AddMemberForm as AddMemberFormUi,
  CreateScopeForm as CreateScopeFormUi,
  type AddMemberFormLabels,
  type CreateScopeFormLabels,
  type RoleOption,
} from '@workspace/ui/components/scope/scope-forms';

import { addScopeMember, createScope } from '@/lib/actions';

export function CreateScopeForm({ labels }: { labels: CreateScopeFormLabels }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleCreate(scope: string) {
    setError(null);
    startTransition(async () => {
      const result = await createScope(scope);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <CreateScopeFormUi
      labels={labels}
      pending={pending}
      error={error}
      onCreate={handleCreate}
    />
  );
}

export function AddMemberForm({
  scope,
  labels,
  roles,
}: {
  scope: string;
  labels: AddMemberFormLabels;
  roles: RoleOption[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function handleAdd(email: string, role: string) {
    setError(null);
    startTransition(async () => {
      const result = await addScopeMember(scope, email, role);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <AddMemberFormUi
      labels={labels}
      roles={roles}
      pending={pending}
      error={error}
      onAdd={handleAdd}
    />
  );
}
