import { GoogleLogin, GoogleOAuthProvider } from '@react-oauth/google';
import { useState, type FormEvent } from 'react';
import { api, useApi, type User } from '../api';
import { useAuth } from '../App';
import { ErrorText } from '../components';

/** Why the server refused a sign-in, in words for the person signing in. */
const REFUSED: Record<string, string> = {
  'not-allowed': "That Google account isn't one of the team's. Sign in with your team Google Workspace account.",
  'not-a-member': "That Google account isn't linked to anyone in the member database. Use the one the team has on file.",
  ambiguous:
    'Several members share that email (a family address?), so it can’t tell who you are. Sign in with an account that’s only yours.',
  unavailable: "The member database can't be reached right now, so new accounts can't sign in. Try again later.",
};

export function LoginPage({ next }: { next: string }) {
  const { setUser } = useAuth();
  const options = useApi<{ googleClientId: string | null; dev: boolean }>('/auth/options');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string>();
  const pairing = next.startsWith('/pair');

  // Signing in doesn't leave the page, so afterwards the app carries on where it was (e.g. /pair).
  const signIn = async (path: string, body: object) => {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
      setError((data.code && REFUSED[data.code]) || data.error || `Sign-in failed (${res.status})`);
      return;
    }
    setUser(await api<User>('GET', '/auth/me'));
  };

  const devLogin = (e: FormEvent) => {
    e.preventDefault();
    void signIn('/auth/dev-login', { email });
  };

  return (
    <main className="narrow">
      <h1>SAR Beepers</h1>
      {pairing && <p>Sign in to finish pairing your pager.</p>}
      <div className="stack">
        {options.data?.googleClientId && (
          <GoogleOAuthProvider clientId={options.data.googleClientId}>
            <div>
              <GoogleLogin
                onSuccess={(r) =>
                  r.credential ? void signIn('/auth/google', { credential: r.credential }) : setError('Google sent no sign-in token.')
                }
                onError={() => setError("Google sign-in didn't work. Try again.")}
                text="signin_with"
              />
            </div>
          </GoogleOAuthProvider>
        )}
        <ErrorText error={error} />
        {options.data && !options.data.googleClientId && !options.data.dev && (
          <p className="muted">Sign-in isn't set up on this server yet (GOOGLE_CLIENT_ID).</p>
        )}
      </div>
      {options.data?.dev && (
        <form onSubmit={devLogin} className="card stack">
          <h2>Development sign-in</h2>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoCapitalize="none" />
          </label>
          <div>
            <button type="submit">Sign in</button>
          </div>
        </form>
      )}
    </main>
  );
}
