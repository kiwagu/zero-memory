import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import type { ReactNode } from 'react';

import { mailTheme } from './mail.theme.js';

export type MailLayoutProps = {
  /** BCP-47 tag for `<html lang>`; the mail catalog's locale. */
  lang: string;
  /** Inbox preview line — the one string read before the mail is opened. */
  preview: string;
  /** Product line in the footer. */
  tagline: string;
  /** Why this address received the message. */
  reason: string;
  children: ReactNode;
};

const body = {
  backgroundColor: mailTheme.color.surface,
  color: mailTheme.color.foreground,
  fontFamily: mailTheme.font.body,
  margin: '0',
  padding: '24px 0',
};

const container = {
  maxWidth: mailTheme.size.container,
  margin: '0 auto',
  padding: '0 16px',
};

const brand = {
  fontFamily: mailTheme.font.mono,
  fontSize: '14px',
  letterSpacing: '0.02em',
  color: mailTheme.color.muted,
  margin: '0 0 12px',
};

const card = {
  backgroundColor: mailTheme.color.background,
  border: `1px solid ${mailTheme.color.border}`,
  borderRadius: '10px',
  padding: '32px 28px',
};

const rule = {
  borderColor: mailTheme.color.border,
  margin: '24px 0 16px',
};

const footnote = {
  fontSize: '12px',
  lineHeight: '18px',
  color: mailTheme.color.muted,
  margin: '0 0 6px',
};

/**
 * The shell every message shares: shape, palette and footer. Both senders use
 * it — authentication mail through the static export, product mail rendered at
 * send time — so the two never drift into looking like different products.
 */
export function MailLayout({
  lang,
  preview,
  tagline,
  reason,
  children,
}: MailLayoutProps) {
  return (
    <Html lang={lang}>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={body}>
        <Container style={container}>
          <Text style={brand}>zero-memory</Text>
          <Section style={card}>{children}</Section>
          <Hr style={rule} />
          <Text style={footnote}>{tagline}</Text>
          <Text style={footnote}>{reason}</Text>
        </Container>
      </Body>
    </Html>
  );
}
