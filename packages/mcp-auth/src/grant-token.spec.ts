import { entityIdSchemas } from '@workspace/contracts';
import { describe, expect, it } from 'vitest';

import {
  grantToken,
  grantTokenIsSigned,
  newGrantSecret,
  parseGrantToken,
} from './grant-token.js';

const GRANT_ID = entityIdSchemas.agent_grant.create();

describe('grant refresh tokens', () => {
  it('names the grant and the generation, and is signed with the grant secret', () => {
    const secret = newGrantSecret();
    const parsed = parseGrantToken(grantToken(GRANT_ID, 3, secret));
    expect(parsed).toMatchObject({ grantId: GRANT_ID, generation: 3 });
    expect(grantTokenIsSigned(parsed!, secret)).toBe(true);
  });

  it('is the same token for the same grant and generation, so a raced refresh can be answered again', () => {
    const secret = newGrantSecret();
    expect(grantToken(GRANT_ID, 1, secret)).toBe(
      grantToken(GRANT_ID, 1, secret)
    );
    expect(grantToken(GRANT_ID, 1, secret)).not.toBe(
      grantToken(GRANT_ID, 2, secret)
    );
  });

  it('is refused under another grant secret or with an edited generation', () => {
    const secret = newGrantSecret();
    const token = grantToken(GRANT_ID, 1, secret);
    expect(grantTokenIsSigned(parseGrantToken(token)!, newGrantSecret())).toBe(
      false
    );
    const edited = token.replace(`~1~`, '~2~');
    expect(grantTokenIsSigned(parseGrantToken(edited)!, secret)).toBe(false);
  });

  it('does not read Auth refresh tokens or anything else as one of ours', () => {
    expect(parseGrantToken('v1abcdefghijklmnop')).toBeNull();
    expect(parseGrantToken(`${GRANT_ID}~1`)).toBeNull();
    expect(parseGrantToken(`oac_x~1~sig`)).toBeNull();
    expect(parseGrantToken(`${GRANT_ID}~-1~sig`)).toBeNull();
    expect(parseGrantToken(`${GRANT_ID}~01~sig`)).toBeNull();
    expect(parseGrantToken(`${GRANT_ID}~1~`)).toBeNull();
  });
});
