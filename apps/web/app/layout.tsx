import type { Metadata } from 'next';
import { Geist_Mono, Inter } from 'next/font/google';

import { TooltipProvider } from '@workspace/ui/components/tooltip';
import { cn } from '@workspace/ui/lib/utils';

import './globals.css';
import { ThemeProvider } from '@/components/theme-provider';
import {
  BROWSER_CONFIG_ELEMENT_ID,
  browserSupabaseConfig,
} from '@/lib/supabase/env';

// Rendered per request, so the same image serves any deployment; see
// lib/supabase/env.ts for why this is not baked in at build time.
export const dynamic = 'force-dynamic';

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' });

const fontMono = Geist_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'zero-memory',
  description: 'Shared memory for coding agents — team dashboard',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        'antialiased',
        'font-sans',
        inter.variable,
        fontMono.variable
      )}
    >
      <body className="min-h-screen bg-background text-foreground">
        <script
          id={BROWSER_CONFIG_ELEMENT_ID}
          type="application/json"
          // Values are public (they shipped in the client bundle before); JSON
          // in a non-executable script tag, so nothing here is evaluated.
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(browserSupabaseConfig()),
          }}
        />
        <ThemeProvider>
          <TooltipProvider delay={300}>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
