import { Download } from 'lucide-react';

import { Alert, AlertDescription } from '@workspace/ui/components/alert';
import { buttonVariants } from '@workspace/ui/components/button';

import { clientBundle, hostedMcpUrl } from '@/lib/client-bundle';

/**
 * The download for the client bundle, resolved at BUILD time (see
 * `lib/client-bundle.ts`). A server component on purpose: the address is baked
 * into the rendered page, so the archive can move without the prose changing —
 * and a build that publishes none says so instead of offering a dead link.
 */
export function ClientBundleDownload() {
  const bundle = clientBundle();

  if (!bundle.url) {
    return (
      <Alert>
        <AlertDescription>
          This build of the documentation ships no download link. Build the
          client from a checkout instead —{' '}
          <code>bash scripts/build-watcher.sh</code> produces{' '}
          <code>dist/zero-memory-watcher</code>, and{' '}
          <code>bash scripts/plugin-bundle/build-zm-bundle.sh &lt;dir&gt;</code>{' '}
          stages the same bundle the installers below expect.
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="not-prose my-6 flex flex-wrap items-center gap-3">
      {/* The shared Button renders its own element, so a download LINK takes
          its styling rather than wrapping it — an anchor is what a download is. */}
      <a href={bundle.url} download className={buttonVariants()}>
        <Download />
        Download the client bundle
      </a>
      <span className="text-fd-muted-foreground text-sm">
        {bundle.fileName}
        {bundle.version ? ` · ${bundle.version}` : ''}
      </span>
    </div>
  );
}

/**
 * The install commands, with the same build-time values interpolated — so the
 * copy-pasted lines and the button can never disagree about which archive and
 * which server the reader is being pointed at.
 */
export function ClientBundleInstall({
  client = 'claude',
}: {
  client?: 'claude' | 'codex' | 'cursor';
}) {
  const bundle = clientBundle();
  // A site-served archive has no address `curl` could fetch — the button above
  // is the download, so the commands begin with the file already on disk. The
  // archive carries one top-level directory named like itself, so they land the
  // same way whichever folder they are run from.
  const lines = [
    ...(bundle.servedBySite
      ? []
      : [`curl -fsSL ${bundle.url ?? '<bundle-url>'} -o ${bundle.fileName}`]),
    // The published archive comes in two formats and the command that opens
    // one does not open the other, so it follows the file name rather than a
    // default that would be wrong half the time.
    /\.(tar\.gz|tgz)$/.test(bundle.fileName)
      ? `tar -xzf ${bundle.fileName} && cd ${bundle.dirName}`
      : `unzip ${bundle.fileName} && cd ${bundle.dirName}`,
    `bash deploy-zm-${client}.sh`,
    `zero-memory-watcher login ${hostedMcpUrl()}`,
  ];
  return (
    <pre className="not-prose bg-fd-secondary text-fd-secondary-foreground my-6 overflow-x-auto rounded-lg p-4 text-sm">
      <code>{lines.join('\n')}</code>
    </pre>
  );
}
