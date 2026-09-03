import { buildVersion } from '@/lib/build-version';

/**
 * The build identity, rendered server-side in a muted half-tone. Placed at
 * the bottom of the auth screens and in the dashboard footer so any
 * screenshot or bug report carries the exact deployed build.
 */
export function BuildVersion({ className = '' }: { className?: string }) {
  return (
    <span
      className={`text-muted-foreground/60 text-xs tabular-nums ${className}`}
    >
      {buildVersion()}
    </span>
  );
}
