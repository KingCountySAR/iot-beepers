import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api } from '../api';
import { ErrorText } from '../components';

/** Landing page for the link shown in the device's setup portal: /pair?code=ABC123 */
export function PairPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [code, setCode] = useState(params.get('code') ?? '');
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { id } = await api<{ id: string }>('POST', '/pair', { code, name: name || undefined });
      navigate(`/devices/${id}?paired=1`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="narrow">
      <h1>Pair a pager</h1>
      <p>Enter the code shown on the pager's setup page. You'll choose which channels it listens to next.</p>
      <form onSubmit={submit} className="stack">
        <label>
          Pairing code
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            maxLength={6}
            className="code"
            autoFocus={!code}
          />
        </label>
        <label>
          Name (optional)
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Bedside" />
        </label>
        <button type="submit" disabled={code.length !== 6}>
          Pair
        </button>
        <ErrorText error={error} />
      </form>
    </section>
  );
}
