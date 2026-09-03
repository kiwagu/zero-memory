'use client';

import * as React from 'react';

import { Button } from '@workspace/ui/components/button';
import { Input } from '@workspace/ui/components/input';

/**
 * SearchForm — a one-field search with a submit button. Mechanism only:
 * labels arrive translated, the routing side effect is the injected
 * `onSearch` callback.
 */

interface SearchFormProps {
  placeholder: string;
  submitLabel: string;
  defaultValue?: string;
  onSearch: (q: string) => void;
}

function SearchForm({
  placeholder,
  submitLabel,
  defaultValue = '',
  onSearch,
}: SearchFormProps) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        onSearch(String(data.get('q') ?? '').trim());
      }}
      className="flex gap-2"
    >
      <Input
        type="search"
        name="q"
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="h-8 w-56"
      />
      <Button type="submit" variant="outline" size="sm">
        {submitLabel}
      </Button>
    </form>
  );
}

export { SearchForm, type SearchFormProps };
