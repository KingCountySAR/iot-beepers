import { OAuth2Client } from 'google-auth-library';

/**
 * "Sign in with Google" with Google Identity Services, as rad-portal does: Google's button on the
 * login page signs the user in, in a popup, and hands the page an ID token, which it posts to
 * POST /api/auth/google. We check Google's signature and the token's claims here. There's no
 * redirect and no client secret; the OAuth client lists the site's origins instead (Authorized
 * JavaScript origins, e.g. http://localhost:4100 and https://<domain>).
 */
export interface GoogleIdentity {
  /** Lowercase, and verified by Google. */
  email: string;
  name: string;
  /**
   * The Google Workspace domain that manages the account (the `hd` claim), lowercase. Missing for
   * consumer accounts, which can be registered with any address, so ALLOWED_DOMAINS checks this
   * rather than the email's domain.
   */
  hostedDomain?: string;
}

/** Checks an ID token from Google's button; throws if it isn't a good one for us. */
export type VerifyGoogleToken = (credential: string) => Promise<GoogleIdentity>;

export function googleVerifier(clientId: string): VerifyGoogleToken {
  const client = new OAuth2Client(clientId);
  return async (credential) => {
    // Checks the signature (against Google's published keys), issuer, audience and expiry.
    const payload = (await client.verifyIdToken({ idToken: credential, audience: clientId })).getPayload();
    if (!payload?.email || !payload.email_verified) throw new Error('Google account has no verified email');
    return { email: payload.email.toLowerCase(), name: payload.name ?? '', hostedDomain: payload.hd?.toLowerCase() };
  };
}
