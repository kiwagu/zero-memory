import { Button, Heading, Link, Text } from '@react-email/components';

import { MailLayout } from '../mail.layout.js';
import { mailTheme } from '../mail.theme.js';

export type AuthNoticeProps = {
  lang: string;
  preview: string;
  heading: string;
  /** One paragraph, already interpolated with the address(es) involved. */
  body: string;
  cta: string;
  /**
   * Where the button points. For authentication mail this is GoTrue's
   * `{{ .ConfirmationURL }}` placeholder, substituted at send time; product
   * code would pass a real URL.
   */
  ctaUrl: string;
  linkFallback: string;
  disclaimer: string;
  tagline: string;
  reason: string;
};

const heading = {
  fontSize: '20px',
  lineHeight: '28px',
  fontWeight: '600',
  color: mailTheme.color.foreground,
  margin: '0 0 12px',
};

const paragraph = {
  fontSize: '15px',
  lineHeight: '24px',
  color: mailTheme.color.foreground,
  margin: '0 0 24px',
};

const button = {
  backgroundColor: mailTheme.color.button,
  color: mailTheme.color.buttonForeground,
  fontSize: '15px',
  fontWeight: '600',
  textDecoration: 'none',
  borderRadius: '8px',
  padding: '12px 20px',
  display: 'inline-block',
};

const fallbackLabel = {
  fontSize: '12px',
  lineHeight: '18px',
  color: mailTheme.color.muted,
  margin: '28px 0 4px',
};

const fallbackLink = {
  fontFamily: mailTheme.font.mono,
  fontSize: '12px',
  lineHeight: '18px',
  color: mailTheme.color.muted,
  wordBreak: 'break-all' as const,
};

const disclaimerText = {
  fontSize: '13px',
  lineHeight: '20px',
  color: mailTheme.color.muted,
  margin: '20px 0 0',
};

/**
 * The one body every authentication message uses: a single action with the raw
 * link repeated for clients that strip buttons. All four authentication
 * templates are this component with different strings — the layout exists once,
 * so a confirmation and a recovery mail cannot drift apart visually.
 */
export function AuthNotice(props: AuthNoticeProps) {
  return (
    <MailLayout
      lang={props.lang}
      preview={props.preview}
      tagline={props.tagline}
      reason={props.reason}
    >
      <Heading as="h1" style={heading}>
        {props.heading}
      </Heading>
      <Text style={paragraph}>{props.body}</Text>
      <Button href={props.ctaUrl} style={button}>
        {props.cta}
      </Button>
      <Text style={fallbackLabel}>{props.linkFallback}</Text>
      <Link href={props.ctaUrl} style={fallbackLink}>
        {props.ctaUrl}
      </Link>
      <Text style={disclaimerText}>{props.disclaimer}</Text>
    </MailLayout>
  );
}
