'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

import { SearchForm } from '@workspace/ui/components/common/search-form';

function EntitySearchInner({
  placeholder,
  submitLabel,
}: {
  placeholder: string;
  submitLabel: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  return (
    <SearchForm
      placeholder={placeholder}
      submitLabel={submitLabel}
      defaultValue={searchParams.get('q') ?? ''}
      onSearch={(q) =>
        router.push(q ? `/entities?q=${encodeURIComponent(q)}` : '/entities')
      }
    />
  );
}

export function EntitySearch(props: {
  placeholder: string;
  submitLabel: string;
}) {
  return (
    <Suspense>
      <EntitySearchInner {...props} />
    </Suspense>
  );
}
