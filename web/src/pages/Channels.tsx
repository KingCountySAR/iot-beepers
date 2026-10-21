import { useState, type FormEvent } from 'react';
import { api, useApi, type Channel } from '../api';
import { ActionButton, ErrorText } from '../components';

export function ChannelsPage() {
  const channels = useApi<Channel[]>('/channels');
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string>();

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', '/channels', { slug, name, description });
      setSlug('');
      setName('');
      setDescription('');
      setError(undefined);
      await channels.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section>
      <h1>Channels</h1>
      <p className="muted">
        Members choose which channels their pager alarms for. Ingest posts to a channel by its slug.
      </p>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Slug</th>
            <th>Description</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {channels.data?.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>
                <code>{c.slug}</code>
              </td>
              <td>{c.description}</td>
              <td>
                <ActionButton
                  className="link"
                  confirm={`Delete channel "${c.name}" and its page history?`}
                  onClick={async () => {
                    await api('DELETE', `/channels/${c.id}`);
                    await channels.reload();
                  }}
                >
                  Delete
                </ActionButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form className="card stack" onSubmit={create}>
        <h2>New channel</h2>
        <label>
          Name
          <input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
            }}
          />
        </label>
        <label>
          Slug
          <input value={slug} onChange={(e) => setSlug(e.target.value)} />
        </label>
        <label>
          Description
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div>
          <button type="submit" disabled={!name || !slug}>
            Create
          </button>
        </div>
        <ErrorText error={error} />
      </form>
    </section>
  );
}
