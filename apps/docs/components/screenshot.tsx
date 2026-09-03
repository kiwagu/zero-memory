'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Maximize2, X } from 'lucide-react';

import { hostedDashboardUrl } from '@/lib/client-bundle';

/**
 * The capture, and the chrome drawn around it.
 *
 * A screenshot is taken at a SMALL viewport with a high device pixel ratio
 * rather than at full size with ratio 1: the dashboard then lays itself out as
 * if the window were ~1100 wide, so type and controls fill the frame, while the
 * file still lands on 1920 real pixels wide. Ratio 1 gave a technically sharp
 * image in which everything was too small to read on a documentation page.
 *
 * The chrome is scaled by the SAME factor. It stands in for a real browser
 * window, and a real window zoomed to 175% has a 175% title bar too — drawing
 * it at 1:1 next to a magnified page makes the frame look like a sticker rather
 * than a window. So every chrome dimension below is a natural browser
 * measurement multiplied by `scale`.
 */
const SCALE = 1.75;

/** Chrome measurements at 1:1, before `SCALE` — what a real browser looks like. */
const CHROME_AT_1X = {
  titleBar: 28,
  addressBar: 40,
  paddingInline: 14,
  button: 12,
  buttonGap: 8,
  addressFont: 13,
  zoomIcon: 15,
};

/** The same, in the pixels a capture is measured in. */
const CHROME = Object.fromEntries(
  Object.entries(CHROME_AT_1X).map(([key, value]) => [
    key,
    Math.round(value * SCALE),
  ])
) as Record<keyof typeof CHROME_AT_1X, number>;

/**
 * Total height the chrome occupies — the amount a full-screen capture must be
 * SHORTER than the frame it lives in, so the two compose to 1920×1080.
 *
 * Published on purpose: the capture height in
 * `tests/e2e/src/web/docs-screenshots.e2e.spec.ts` and the note in this app's
 * README are derived from it and must move with it.
 */
export const CHROME_HEIGHT = CHROME.titleBar + CHROME.addressBar;

/** How a full-screen capture is taken, so that chrome + capture is 1920×1080. */
export const CAPTURE = {
  scale: SCALE,
  /** CSS pixels the page lays out in: the image size divided by the scale. */
  viewport: {
    width: Math.round(1920 / SCALE),
    height: Math.round((1080 - CHROME_HEIGHT) / SCALE),
  },
  /** The resulting file, within a pixel of rounding. */
  image: { width: 1920, height: 1080 - CHROME_HEIGHT },
};

/**
 * The chrome scales WITH the image instead of sitting at a fixed pixel height.
 *
 * The frame promises a 1920×1080 composition, but a page renders the image at
 * whatever width the column allows — so a chrome fixed at 80px would keep its
 * height while the picture shrank, and the composition would drift away from
 * 16:9 on every screen except a full-width one. Sizing it in `cqw` (percent of
 * the figure's own width) keeps the ratio exact at any width. The `max(…, …px)`
 * floors stop the bar from becoming an unreadable sliver on a phone, where a
 * legible frame matters more than an exact ratio. They are deliberately LOW —
 * a floor that engages at ordinary reading widths would silently reintroduce
 * the very drift this sizing exists to remove (they take over below ~640px).
 */
const px = (value: number, floor: number): string =>
  `max(${((value / 1920) * 100).toFixed(4)}cqw, ${floor}px)`;

/** The three window buttons — decoration, so they are hidden from readers. */
function WindowButtons() {
  return (
    <div
      className="flex items-center"
      style={{ gap: px(CHROME.buttonGap, 3) }}
      aria-hidden
    >
      {['#ff5f57', '#febc2e', '#28c840'].map((color) => (
        <span
          key={color}
          className="rounded-full"
          style={{
            width: px(CHROME.button, 4),
            height: px(CHROME.button, 4),
            backgroundColor: color,
          }}
        />
      ))}
    </div>
  );
}

/**
 * Title bar plus address bar — the part of the frame that is drawn, not
 * photographed.
 *
 * It is a component rather than inline markup because the zoom overlay renders
 * the SAME chrome at the capture's own width: the enlarged view is then the
 * whole window, in proportion, instead of a bare screenshot that suddenly loses
 * its frame.
 */
function ChromeBars({
  href,
  shown,
  onZoom,
}: {
  href: string;
  shown: string;
  onZoom?: () => void;
}) {
  return (
    <>
      <div
        className="border-fd-border bg-fd-muted flex items-center border-b"
        style={{
          height: px(CHROME.titleBar, 12),
          paddingInline: px(CHROME.paddingInline, 6),
        }}
      >
        <WindowButtons />
      </div>
      <div
        className="border-fd-border bg-fd-card flex items-center border-b"
        style={{
          height: px(CHROME.addressBar, 16),
          paddingInline: px(CHROME.paddingInline, 6),
        }}
      >
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          title="Open this screen in the live dashboard"
          className="text-fd-muted-foreground hover:text-fd-foreground truncate font-mono transition-colors"
          style={{ fontSize: px(CHROME.addressFont, 8) }}
        >
          {shown}
        </a>
        {onZoom ? (
          <button
            type="button"
            onClick={onZoom}
            title="View at full size"
            aria-label="View this screenshot at full size"
            className="text-fd-muted-foreground hover:text-fd-foreground ml-auto shrink-0 transition-colors"
          >
            <Maximize2
              style={{
                width: px(CHROME.zoomIcon, 10),
                height: px(CHROME.zoomIcon, 10),
              }}
            />
          </button>
        ) : null}
      </div>
    </>
  );
}

/**
 * The file as captured, rather than the size the page happened to request.
 *
 * The framed image is served through Next's optimizer, so its URL is
 * `/_next/image?url=<encoded original>&w=<column width>` — following it would
 * open a downscaled copy, which is precisely what "full size" must not do. The
 * original is the `url` parameter; anything else is already an original.
 */
function originalSrc(src: string): string {
  try {
    const url = new URL(src, 'http://localhost');
    const inner = url.searchParams.get('url');
    return inner ?? src;
  } catch {
    return src;
  }
}

/**
 * A screenshot presented as a browser window: title bar, address bar naming the
 * page it was taken on, then the image.
 *
 * The chrome is drawn HERE rather than baked into the PNG, which buys three
 * things a raster cannot have: the address is a real link, the frame follows the
 * reader's light/dark theme, and re-shooting the capture never costs the frame.
 *
 * The image arrives as `children` — a plain markdown image — on purpose: that
 * way it still goes through the MDX image pipeline (static import, intrinsic
 * dimensions, `next/image`), which a `src` string prop would throw away.
 */
export function Screenshot({
  path,
  children,
}: {
  /** Dashboard path the shot was taken on, e.g. `/memories`. */
  path: string;
  children: ReactNode;
}) {
  const base = hostedDashboardUrl();
  const href = `${base}${path}`;
  const shown = `${base.replace(/^https?:\/\//, '')}${path}`;

  // A page column is far narrower than the capture, so the frame always shows
  // the shot scaled down. The overlay is how a reader gets the pixels that
  // were actually taken — the same reason a screenshot is worth 1920 wide in
  // the first place.
  const frame = useRef<HTMLElement>(null);
  const [zoomed, setZoomed] = useState(false);
  const [source, setSource] = useState<{ src: string; alt: string } | null>(
    null
  );

  // Read the rendered <img> rather than taking a `src` prop: the image comes in
  // as markdown so that it keeps the MDX image pipeline, which means its final
  // URL is only known after render.
  useEffect(() => {
    const image = frame.current?.querySelector('img');
    if (image) {
      setSource({
        src: originalSrc(image.currentSrc || image.src),
        alt: image.alt,
      });
    }
  }, []);

  // Escape closes it, and the page must not scroll behind the overlay.
  useEffect(() => {
    if (!zoomed) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setZoomed(false);
      }
    };
    document.addEventListener('keydown', onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [zoomed]);

  return (
    <figure
      ref={frame}
      className="not-prose border-fd-border my-6 overflow-hidden rounded-md border shadow-sm [container-type:inline-size]"
    >
      <ChromeBars href={href} shown={shown} onZoom={() => setZoomed(true)} />
      {/* The whole picture is the target, not just the icon: a reader's instinct
          is to click the screenshot itself. A div rather than a <button>
          because the markdown image arrives wrapped in a paragraph, which a
          button may not contain — so the keyboard affordance is added by hand. */}
      <div
        role="button"
        tabIndex={0}
        aria-label="View this screenshot at full size"
        onClick={() => setZoomed(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setZoomed(true);
          }
        }}
        className="focus-visible:ring-fd-ring cursor-zoom-in focus-visible:ring-2 focus-visible:outline-none [&_img]:my-0 [&_img]:block [&_img]:w-full [&_img]:rounded-none [&_p]:my-0"
      >
        {children}
      </div>

      {zoomed && source ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={source.alt || 'Screenshot at full size'}
          onClick={() => setZoomed(false)}
          className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-black/80 p-4"
        >
          <button
            type="button"
            onClick={() => setZoomed(false)}
            aria-label="Close"
            className="fixed top-4 right-4 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20"
          >
            <X className="size-5" />
          </button>
          {/* The WHOLE window: chrome is sized in `cqw`, so at the capture's own
              width the bars land on exactly the pixels they were designed for
              (36 + 44 = 80) and the view reads as one picture rather than a
              screenshot that lost its frame. Capped at the capture width so a
              wide display shows true 1:1, while a narrower one scales the whole
              window down in proportion instead of cropping it.

              A plain <img> on purpose: `next/image` exists to resize and lazily
              deliver, which is the opposite of what this overlay is for, and it
              would need dimensions this component does not have. The bytes are
              already in the browser's cache — this reuses the very URL the
              framed image resolved to. */}
          <div
            onClick={(event) => event.stopPropagation()}
            style={{ maxWidth: CAPTURE.image.width }}
            className="border-fd-border w-full shrink-0 overflow-hidden rounded-md border shadow-2xl [container-type:inline-size]"
          >
            <ChromeBars href={href} shown={shown} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={source.src}
              alt={source.alt}
              className="block w-full max-w-none"
            />
          </div>
        </div>
      ) : null}
    </figure>
  );
}
