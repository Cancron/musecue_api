/**
 * Google OAuth Interfaces
 * Type definitions for Google OAuth 2.0 implementation
 */

/**
 * Google OAuth Token Response
 */
export interface IGoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token?: string;
}

/**
 * Google User Info Response
 */
export interface IGoogleUserInfo {
  sub: string; // Google's unique user ID
  email: string;
  email_verified: boolean;
  name: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
}

/**
 * Google OAuth state data (stored encrypted in OAuthState)
 */
export interface IGoogleOAuthState {
  state: string;
  codeVerifier: string; // For PKCE
  redirectUrl?: string; // Where to redirect after successful auth
  // SHA-256 of the trusted-device token sent when the flow started (never
  // the token itself): lets an MFA user's trusted device skip the challenge.
  trustedDeviceTokenHash?: string;
  ip: string;
  userAgent: string;
  createdAt: string;
}

/**
 * Google ID Token Claims (JWT payload)
 */
export interface IGoogleIdTokenClaims {
  iss: string; // Issuer (accounts.google.com or https://accounts.google.com)
  azp: string; // Authorized party
  aud: string; // Audience (client_id)
  sub: string; // Subject (Google user ID)
  email: string;
  email_verified: boolean;
  at_hash?: string; // Access token hash
  name?: string;
  picture?: string;
  given_name?: string;
  family_name?: string;
  locale?: string;
  iat: number; // Issued at
  exp: number; // Expiration time
}

/**
 * Google OAuth Callback Query Parameters
 */
export interface IGoogleOAuthCallback {
  code?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

/**
 * Google OAuth Login Response
 */
export interface IGoogleOAuthLoginResponse {
  mfaRequired: false;
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    username: string;
    role: string;
    verified: boolean;
    provider: string;
    providerId: string;
  };
  expiresIn: number;
  isNewUser: boolean;
  redirectUrl?: string;
}

/**
 * Google sign-in of a user with MFA enabled: no tokens yet, only the MFA
 * challenge to complete at POST /auth/login/mfa.
 */
export interface IGoogleOAuthMfaChallengeResponse {
  mfaRequired: true;
  challengeToken: string;
  expiresAt: Date;
  methods: string[];
  isNewUser: false;
  redirectUrl?: string;
}

/**
 * Google OAuth Error Response
 */
export interface IGoogleOAuthError {
  error: string;
  error_description?: string;
}
