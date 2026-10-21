import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, type User } from '../api';
import { useAuth } from '../App';
import { ErrorText } from '../components';

export function LoginPage({ next }: { next: string }) {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const pairing = next.startsWith('/pair');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setUser(await api<User>('POST', '/auth/login', { username, password }));
      navigate(next, { replace: true });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <main className="narrow">
      <h1>SAR Notifier</h1>
      {pairing && <p>Log in to finish pairing your pager.</p>}
      <form onSubmit={submit} className="stack">
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoCapitalize="none" />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button type="submit">Log in</button>
        <ErrorText error={error} />
      </form>
    </main>
  );
}
