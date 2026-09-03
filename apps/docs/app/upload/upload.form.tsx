'use client';

import { useActionState, useState } from 'react';
import { FileText } from 'lucide-react';

import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { Button } from '@workspace/ui/components/button';
import { Dropzone } from '@workspace/ui/components/common/dropzone';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@workspace/ui/components/field';
import { Input } from '@workspace/ui/components/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@workspace/ui/components/select';
import { Textarea } from '@workspace/ui/components/textarea';

import type { UploadResult } from '@/lib/upload.schema';

import { uploadDocument } from './upload.actions';

async function submit(
  _previous: UploadResult | null,
  formData: FormData
): Promise<UploadResult> {
  return uploadDocument(formData);
}

const CONTENT_TEMPLATE =
  '---\ntitle: My page\ndescription: One line.\n---\n\nBody…';

const EXISTING_PATH_MODES = [
  { value: 'create', label: 'Refuse — keep the page' },
  { value: 'replace', label: 'Replace the page' },
];

export function UploadForm({ enabled }: { enabled: boolean }) {
  const [result, formAction, pending] = useActionState(submit, null);
  const [content, setContent] = useState('');
  const [path, setPath] = useState('');

  async function onFiles(files: File[]) {
    const file = files[0];
    if (!file) {
      return;
    }
    setContent(await file.text());
    setPath((current) => current || file.name);
  }

  return (
    <form action={formAction}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="upload-path">Path in the docs tree</FieldLabel>
          <Input
            id="upload-path"
            name="path"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="guides/my-new-page.mdx"
            required
            disabled={!enabled}
          />
          <FieldDescription>
            Relative to the content root, at most two folders deep, ending in
            .md or .mdx.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="upload-content">Markdown</FieldLabel>
          <Dropzone
            accept=".md,.mdx"
            disabled={!enabled}
            onFiles={onFiles}
            icon={<FileText className="size-5" aria-hidden />}
            labels={{
              hint: 'Drop a markdown file here',
              browse: 'or browse for one',
            }}
            testId="docs-upload-dropzone"
          />
          <Textarea
            id="upload-content"
            name="content"
            className="min-h-72 font-mono"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={CONTENT_TEMPLATE}
            required
            disabled={!enabled}
          />
          <FieldDescription>
            Must open with a frontmatter block that sets a title and a
            description.
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="upload-mode">If the path exists</FieldLabel>
          {/* `items` lets the trigger show the label before the list is
              ever opened — without it the raw value leaks into the UI. */}
          <Select
            name="mode"
            defaultValue="create"
            items={EXISTING_PATH_MODES}
            disabled={!enabled}
          >
            <SelectTrigger id="upload-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXISTING_PATH_MODES.map((mode) => (
                <SelectItem key={mode.value} value={mode.value}>
                  {mode.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field>
          <FieldLabel htmlFor="upload-token">Upload token</FieldLabel>
          <Input
            id="upload-token"
            name="token"
            type="password"
            required
            disabled={!enabled}
          />
        </Field>

        <Button
          type="submit"
          disabled={!enabled || pending}
          className="self-start"
        >
          {pending ? 'Publishing…' : 'Publish page'}
        </Button>

        {result?.status === 'written' && (
          <Alert>
            <AlertDescription>
              {result.replaced ? 'Replaced' : 'Created'}{' '}
              <code>{result.path}</code> —{' '}
              <a className="underline" href={result.url}>
                open the page
              </a>
              . Add it to the folder&rsquo;s <code>meta.json</code> to place it
              in the sidebar.
            </AlertDescription>
          </Alert>
        )}

        {result?.status === 'rejected' && (
          <Alert variant="destructive">
            <AlertDescription>{result.message}</AlertDescription>
          </Alert>
        )}
      </FieldGroup>
    </form>
  );
}
