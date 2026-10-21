import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../App';
import { ErrorText } from '../components';

export function AccountPage() {
  const { user } = useAuth();
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('PUT', '/auth/password', { current, password });
      setDone(true);
      setError(undefined);
      setCurrent('');
      setPassword('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="narrow">
      <h1>{user?.displayName}</h1>
      <form className="stack" onSubmit={submit}>
        <h2>Change password</h2>
        <label>
          Current password
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label>
          New password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <div>
          <button type="submit">Change password</button>
        </div>
        {done && <p className="ok-text">Password changed.</p>}
        <ErrorText error={error} />
      </form>
    </section>
  );
}
