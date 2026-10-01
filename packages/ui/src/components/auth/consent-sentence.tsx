import * as React from 'react';

/**
 * What a deployment asks a new account to accept. Absent = the instance
 * publishes no documents, and then nothing about consent is rendered at all.
 *
 * `template` carries the two placeholders `{terms}` and `{privacy}`; each is
 * replaced by a link when its address is configured and by plain text when it
 * is not, so an instance that publishes only one document still reads as a
 * sentence.
 */
interface ConsentCopy {
  template: string;
  termsLabel: string;
  privacyLabel: string;
  termsHref?: string;
  privacyHref?: string;
}

/**
 * The consent sentence with its links in place. The copy arrives already
 * translated, so the only thing decided here is where a link goes — splitting
 * on the placeholders keeps the word order of every language intact, which
 * concatenating fragments would not.
 */
function ConsentSentence({ consent }: { consent: ConsentCopy }) {
  const parts = consent.template.split(/(\{terms\}|\{privacy\})/g);
  return (
    <span>
      {parts.map((part, index) => {
        const isTerms = part === '{terms}';
        const isPrivacy = part === '{privacy}';
        if (!isTerms && !isPrivacy) {
          return <React.Fragment key={index}>{part}</React.Fragment>;
        }
        const label = isTerms ? consent.termsLabel : consent.privacyLabel;
        const href = isTerms ? consent.termsHref : consent.privacyHref;
        if (!href) {
          return <React.Fragment key={index}>{label}</React.Fragment>;
        }
        return (
          <a
            key={index}
            href={href}
            target="_blank"
            rel="noreferrer"
            data-testid={isTerms ? 'auth-login-terms' : 'auth-login-privacy'}
            className="text-foreground underline underline-offset-2"
          >
            {label}
          </a>
        );
      })}
    </span>
  );
}

export { ConsentSentence, type ConsentCopy };
