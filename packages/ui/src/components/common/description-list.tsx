import { cn } from '@workspace/ui/lib/utils';
import * as React from 'react';

export type DescriptionListItem = {
  /** The resolved (already-i18n'd) term shown in the muted left column. */
  label: React.ReactNode;
  /** The value shown in the right column. */
  value: React.ReactNode;
  /** `title` attribute for the value cell (surface the full text when truncated). */
  valueTitle?: string;
  /** Clamp the value to a single truncated line. */
  truncate?: boolean;
};

/**
 * DescriptionList — a compact two-column key/value list on a semantic `<dl>`: a muted
 * label column sized to its content and a value column that fills the rest. Mechanism
 * only and i18n-free (the caller passes already-resolved `label`/`value` pairs), so it
 * is reusable for any at-a-glance facts readout — media type/size/filename, settings
 * resolutions, panel details. Renders nothing when `items` is empty. Semantic tokens
 * only; dark mode is automatic.
 */
function DescriptionList({
  items,
  className,
  ...props
}: React.ComponentProps<'dl'> & { items: DescriptionListItem[] }) {
  if (items.length === 0) {
    return null;
  }
  return (
    <dl
      className={cn(
        'grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-0.5 text-xs',
        className
      )}
      {...props}
    >
      {items.map((item, index) => (
        <React.Fragment key={index}>
          <dt className="text-muted-foreground">{item.label}</dt>
          <dd
            className={cn('text-foreground/80', item.truncate && 'truncate')}
            title={item.valueTitle}
          >
            {item.value}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  );
}

export { DescriptionList };
