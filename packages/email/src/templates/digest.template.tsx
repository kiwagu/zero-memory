import {
  Button,
  Column,
  Heading,
  Row,
  Section,
  Text,
} from '@react-email/components';

import { MailLayout } from '../mail.layout.js';
import { mailTheme } from '../mail.theme.js';

export type DigestStat = {
  label: string;
  value: number;
};

export type DigestMailProps = {
  lang: string;
  preview: string;
  heading: string;
  /** Rendered period, e.g. "12 Jan — 18 Jan". */
  period: string;
  body: string;
  /**
   * Counts only. The digest carries no memory content by design: a summary
   * that quoted memories would move private content into an inbox and a mail
   * provider's logs, which is exactly what this product is not for.
   */
  stats: readonly DigestStat[];
  cta: string;
  dashboardUrl: string;
  tagline: string;
  reason: string;
};

const heading = {
  fontSize: '20px',
  lineHeight: '28px',
  fontWeight: '600',
  color: mailTheme.color.foreground,
  margin: '0 0 4px',
};

const period = {
  fontFamily: mailTheme.font.mono,
  fontSize: '13px',
  lineHeight: '20px',
  color: mailTheme.color.muted,
  margin: '0 0 16px',
};

const paragraph = {
  fontSize: '15px',
  lineHeight: '24px',
  color: mailTheme.color.foreground,
  margin: '0 0 20px',
};

const statsSection = {
  border: `1px solid ${mailTheme.color.border}`,
  borderRadius: '8px',
  padding: '4px 16px',
  margin: '0 0 24px',
};

const statLabel = {
  fontSize: '14px',
  lineHeight: '22px',
  color: mailTheme.color.muted,
  margin: '10px 0',
};

const statValue = {
  fontFamily: mailTheme.font.mono,
  fontSize: '16px',
  lineHeight: '22px',
  fontWeight: '600',
  color: mailTheme.color.foreground,
  margin: '10px 0',
  textAlign: 'right' as const,
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

/**
 * The weekly summary — the first product-sent message, rendered at send time
 * rather than exported, because it carries data. Shares the layout with the
 * authentication mail so both senders look like one product.
 */
export function DigestMail(props: DigestMailProps) {
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
      <Text style={period}>{props.period}</Text>
      <Text style={paragraph}>{props.body}</Text>
      <Section style={statsSection}>
        {props.stats.map((stat) => (
          <Row key={stat.label}>
            <Column>
              <Text style={statLabel}>{stat.label}</Text>
            </Column>
            <Column>
              <Text style={statValue}>{stat.value}</Text>
            </Column>
          </Row>
        ))}
      </Section>
      <Button href={props.dashboardUrl} style={button}>
        {props.cta}
      </Button>
    </MailLayout>
  );
}
