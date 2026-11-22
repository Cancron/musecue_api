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
  // Referral code to register if the sign-in creates a new account
  referralCode?: string;
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
  /**
   * Present when a referral code was given: registered with the new
   * account, or not applied because the account already existed (a
   * retrospective referral).
   */
  referral?: { applied: boolean; reason?: 'EXISTING_ACCOUNT' };
}

/**
 * Google OAuth Error Response
 */
export interface IGoogleOAuthError {
  error: string;
  error_description?: string;
}
