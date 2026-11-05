import axios from 'axios';
import { getAppConfig } from '../config/env';

/**
 * Turns a LINE (LIFF) access token into the LINE userId it was issued to. The API never accepts a
 * lineUserId from the client directly (SRS 6.2).
 */
export interface LineIdentityVerifier {
  /** Returns the LINE userId, or null when the token is invalid, expired or for another channel. */
  verify(accessToken: string): Promise<string | null>;
}

/** Real verifier: LINE oauth2/v2.1/verify (channel + expiry), then /v2/profile for the userId. */
export class LineApiIdentityVerifier implements LineIdentityVerifier {
  constructor(private readonly channelId: string) {}

  async verify(accessToken: string): Promise<string | null> {
    if (!accessToken || !this.channelId) return null;
    try {
      const check = await axios.get('https://api.line.me/oauth2/v2.1/verify', {
        params: { access_token: accessToken },
        timeout: 5000,
      });
      if (String(check.data?.client_id) !== this.channelId || !(Number(check.data?.expires_in) > 0)) {
        return null;
      }
      const profile = await axios.get('https://api.line.me/v2/profile', {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 5000,
      });
      const userId = profile.data?.userId;
      return typeof userId === 'string' && userId.length > 0 ? userId : null;
    } catch {
      return null;
    }
  }
}

/** Test-only verifier: accepts "mock:<userId>". Config refuses it unless NODE_ENV=test. */
export class MockLineIdentityVerifier implements LineIdentityVerifier {
  async verify(accessToken: string): Promise<string | null> {
    const match = /^mock:(U[A-Za-z0-9_]{1,60})$/.exec(accessToken ?? '');
    return match ? match[1] : null;
  }
}

export function getLineIdentityVerifier(): LineIdentityVerifier {
  const config = getAppConfig();
  if (config.lineIdentityVerifier === 'mock') {
    // Double guard: config validation already rejects mock outside tests
    if (process.env.NODE_ENV !== 'test') throw new Error('Mock LINE identity verifier is only allowed in tests');
    return new MockLineIdentityVerifier();
  }
  return new LineApiIdentityVerifier(config.lineLoginChannelId);
}
