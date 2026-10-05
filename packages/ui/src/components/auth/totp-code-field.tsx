'use client';

import * as React from 'react';
import { REGEXP_ONLY_DIGITS } from 'input-otp';

import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from '@workspace/ui/components/input-otp';

/** How many digits an authenticator app shows. */
const TOTP_CODE_LENGTH = 6;

/**
 * What a paste becomes before it reaches the cells. Authenticator apps and
 * password managers copy a code as `123456`, `123 456` or `123-456`; all three
 * are the same code, so the spaces and dashes go and the digits fill all six
 * cells at once. Anything still not digits is then refused by the field.
 */
function normalizeTotpPaste(text: string): string {
  return text.replace(/[\s-]/g, '');
}

interface TotpCodeFieldProps {
  /** The input's id, for a label that names it. */
  id: string;
  /** The field's name for screen readers when no visible label names it. */
  ariaLabel?: string;
  testId: string;
  value: string;
  onChange: (value: string) => void;
  /**
   * The code, once, as soon as the last digit lands — typed, pasted or filled
   * in by the phone or a password manager. The form submits itself from here.
   */
  onComplete: (code: string) => void;
  /** While a code is being checked: no edits and no second submission. */
  disabled?: boolean;
  /** The last code was refused. */
  invalid?: boolean;
  autoFocus?: boolean;
}

/**
 * TotpCodeField — six cells for the code from an authenticator app, three and
 * three around a dash, the way code fields usually work: focus moves to the
 * next cell with each digit, a paste fills every cell, and the last digit
 * submits by itself. Underneath it is one real input, so one-time-code
 * autofill and password managers keep working. After a refused code the
 * owner clears the value and the field takes focus back on its first cell.
 */
function TotpCodeField({
  id,
  ariaLabel,
  testId,
  value,
  onChange,
  onComplete,
  disabled = false,
  invalid = false,
  autoFocus = false,
}: TotpCodeFieldProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  // The code last handed over: the same six digits are not sent twice, until
  // the value is shortened and a new attempt begins.
  const submitted = React.useRef<string | null>(null);
  const wasDisabled = React.useRef(disabled);

  React.useEffect(() => {
    if (value.length < TOTP_CODE_LENGTH) {
      submitted.current = null;
    }
  }, [value]);

  React.useEffect(() => {
    // Back from a check with the cells cleared: the code was refused, and the
    // person types the next one without reaching for the mouse.
    if (wasDisabled.current && !disabled && value === '') {
      inputRef.current?.focus();
    }
    wasDisabled.current = disabled;
  }, [disabled, value]);

  const complete = (code: string) => {
    if (disabled || submitted.current === code) {
      return;
    }
    submitted.current = code;
    onComplete(code);
  };

  const slot = (index: number) => (
    <InputOTPSlot
      index={index}
      aria-invalid={invalid || undefined}
      className="size-10 text-base"
    />
  );

  return (
    <InputOTP
      ref={inputRef}
      id={id}
      aria-label={ariaLabel}
      data-testid={testId}
      maxLength={TOTP_CODE_LENGTH}
      value={value}
      onChange={onChange}
      onComplete={complete}
      pattern={REGEXP_ONLY_DIGITS}
      pasteTransformer={normalizeTotpPaste}
      inputMode="numeric"
      autoComplete="one-time-code"
      autoFocus={autoFocus}
      disabled={disabled}
      containerClassName="gap-2"
    >
      <InputOTPGroup>
        {slot(0)}
        {slot(1)}
        {slot(2)}
      </InputOTPGroup>
      <InputOTPSeparator />
      <InputOTPGroup>
        {slot(3)}
        {slot(4)}
        {slot(5)}
      </InputOTPGroup>
    </InputOTP>
  );
}

export {
  TotpCodeField,
  TOTP_CODE_LENGTH,
  normalizeTotpPaste,
  type TotpCodeFieldProps,
};
