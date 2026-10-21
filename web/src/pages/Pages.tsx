import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { api, fmtTime, useApi, type Channel, type PageDetail, type PageSummary } from '../api';
import { useAuth } from '../App';
import { ErrorText } from '../components';

export function PagesPage() {
  const { user } = useAuth();
  const pages = useApi<PageSummary[]>('/pages', 5000);

  return (
    <section>
      {user?.isAdmin && <SendPage onSent={pages.reload} />}
      <h1>Page history</h1>
      <ErrorText error={pages.error} />
      <table>
        <thead>
          <tr>
            <th>When</th>
            <th>Channel</th>
            <th>Message</th>
            <th>Received</th>
            <th>Acked</th>
          </tr>
        </thead>
        <tbody>
          {pages.data?.map((p) => (
            <tr key={p.id}>
              <td className="nowrap">
                <Link to={`/pages/${p.id}`}>{fmtTime(p.createdAt)}</Link>
              </td>
              <td>{p.channelName}</td>
              <td>
                {p.title && <strong>{p.title}: </strong>}
                {p.body}
              </td>
              <td>
                {p.received}/{p.targets}
              </td>
              <td>
                {p.acked}/{p.targets}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function SendPage({ onSent }: { onSent: () => void }) {
  const channels = useApi<Channel[]>('/channels');
  const [channelId, setChannelId] = useState<number | ''>('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [result, setResult] = useState<string>();
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (channelId === '') return;
    const ch = channels.data?.find((c) => c.id === channelId);
    if (!window.confirm(`Send this page to every pager on "${ch?.name}"? They will alarm.`)) return;
    try {
      const res = await api<{ targets: number }>('POST', '/pages', { channelId, title, body });
      setResult(`Sent to ${res.targets} pager(s).`);
      setError(undefined);
      setBody('');
      setTitle('');
      onSent();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className="card stack" onSubmit={submit}>
      <h2>Send a page</h2>
      <label>
        Channel
        <select value={channelId} onChange={(e) => setChannelId(e.target.value ? Number(e.target.value) : '')}>
          <option value="">Choose…</option>
          {channels.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} />
      </label>
      <label>
        Message
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} maxLength={2000} />
      </label>
      <div>
        <button type="submit" disabled={channelId === '' || !body}>
          Send page
        </button>
      </div>
      {result && <p className="ok-text">{result}</p>}
      <ErrorText error={error} />
    </form>
  );
}

export function PagePage() {
  const { id } = useParams();
  const page = useApi<PageDetail>(`/pages/${id}`, 3000);
  const p = page.data;
  if (page.error) return <ErrorText error={page.error} />;
  if (!p) return null;

  return (
    <section>
      <p>
        <Link to="/pages">← Page history</Link>
      </p>
      <h1>{p.title || 'Page'}</h1>
      <p className="pre">{p.body}</p>
      <p className="muted">
        Sent {fmtTime(p.createdAt)} via {p.source} · expires {fmtTime(p.expiresAt)}
      </p>
      <table>
        <thead>
          <tr>
            <th>Member</th>
            <th>Pager</th>
            <th>Sent</th>
            <th>Received</th>
            <th>Acknowledged</th>
          </tr>
        </thead>
        <tbody>
          {p.deliveries.map((d) => (
            <tr key={d.deviceId}>
              <td>{d.ownerName ?? '—'}</td>
              <td>
                <Link to={`/devices/${d.deviceId}`}>{d.deviceName || d.deviceId}</Link>
              </td>
              <td>{d.sentAt ? fmtTime(d.sentAt) : <span className="muted">waiting for device</span>}</td>
              <td>{fmtTime(d.receivedAt)}</td>
              <td>{fmtTime(d.ackedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
