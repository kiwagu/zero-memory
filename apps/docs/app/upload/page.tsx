import { HomeLayout } from 'fumadocs-ui/layouts/home';
import type { Metadata } from 'next';

import { baseOptions } from '@/lib/layout.shared';

import { isUploadEnabled } from './upload.actions';
import { UploadForm } from './upload.form';

export const metadata: Metadata = {
  title: 'Upload a page',
  description: 'Publish a markdown page into the documentation tree.',
};

export default async function UploadPage() {
  const enabled = await isUploadEnabled();

  return (
    <HomeLayout {...baseOptions()}>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-12">
        <div className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold">Upload a page</h1>
          <p className="text-fd-muted-foreground">
            Pages are markdown files in the repository&rsquo;s docs tree. This
            form writes one there directly, so the site and the repository never
            hold two different versions of the same page.
          </p>
        </div>

        {!enabled && (
          <p className="border-fd-border bg-fd-muted rounded-lg border px-3 py-2 text-sm">
            Uploading is disabled on this deployment. It turns on when the
            operator sets <code>ZM_DOCS_UPLOAD_TOKEN</code>.
          </p>
        )}

        <UploadForm enabled={enabled} />
      </main>
    </HomeLayout>
  );
}
