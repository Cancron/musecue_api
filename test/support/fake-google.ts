import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { JwksClient } from 'jwks-rsa';
import { GOOGLE_OAUTH_CONFIG } from '../../src/auth/config/google-oauth.config';

export interface FakeGoogleUser {
  sub: string;
  email: string;
  name: string;
}

/**
 * Stands in for Google's servers in e2e tests: the token endpoint (code
 * exchange) and the signing keys (JWKS). ID tokens are real RS256 JWTs
 * signed with a test key, so the application's own verification (signature,
 * issuer, audience, expiry, email_verified) runs unchanged. Every other
 * `fetch` passes through.
 */
export class FakeGoogle {
  readonly clientId = 'e2e-client.apps.googleusercontent.com';
  private readonly keyId = `e2e-${randomBytes(4).toString('hex')}`;
  private readonly keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  private readonly codes = new Map<string, FakeGoogleUser>();
  private spies: jest.SpyInstance[] = [];

  install() {
    process.env.GOOGLE_CLIENT_ID = this.clientId;
    process.env.GOOGLE_CLIENT_SECRET = 'e2e-client-secret';
    process.env.GOOGLE_REDIRECT_URI =
      'https://api.example.com/auth/google/callback';

    const originalFetch = global.fetch;
    this.spies.push(
      jest
        .spyOn(global, 'fetch')
        .mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
          const url =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          if (url !== GOOGLE_OAUTH_CONFIG.ENDPOINTS.TOKEN) {
            return originalFetch(input, init);
          }
          // The application posts a URL-encoded string body.
          const body = new URLSearchParams(
            typeof init?.body === 'string' ? init.body : '',
          );
          const user = this.codes.get(body.get('code') ?? '');
          if (!user || !body.get('code_verifier')) {
            return Promise.resolve(
              Response.json({ error: 'invalid_grant' }, { status: 400 }),
            );
          }
          this.codes.delete(body.get('code') as string);
          return Promise.resolve(
            Response.json({
              access_token: `ya29.${randomBytes(8).toString('hex')}`,
              expires_in: 3599,
              token_type: 'Bearer',
              scope: 'openid email profile',
              id_token: this.idToken(user),
            }),
          );
        }),
    );
    // Google's JWKS document. jwks-rsa wraps getSigningKey per instance at
    // construction, but reads the document through getKeys at call time, so
    // its own key conversion and kid matching still run.
    const jwk = {
      ...createPublicKey(this.keys.publicKey).export({ format: 'jwk' }),
      kid: this.keyId,
      alg: 'RS256',
      use: 'sig',
    };
    this.spies.push(
      jest
        .spyOn(JwksClient.prototype, 'getKeys')
        .mockResolvedValue([jwk] as never),
    );
  }

  uninstall() {
    this.spies.forEach((spy) => spy.mockRestore());
    this.spies = [];
  }

  /** The authorization code Google would send back for `user`. */
  codeFor(user: FakeGoogleUser): string {
    const code = `4/${randomBytes(12).toString('hex')}`;
    this.codes.set(code, user);
    return code;
  }

  private idToken(user: FakeGoogleUser): string {
    return jwt.sign(
      {
        sub: user.sub,
        email: user.email,
        email_verified: true,
        name: user.name,
        given_name: user.name.split(' ')[0],
        azp: this.clientId,
      },
      this.keys.privateKey,
      {
        algorithm: 'RS256',
        keyid: this.keyId,
        issuer: 'https://accounts.google.com',
        audience: this.clientId,
        expiresIn: '1h',
      },
    );
  }
}
