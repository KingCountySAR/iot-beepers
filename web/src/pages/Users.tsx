import { useState, type FormEvent } from 'react';
import { api, fmtTime, useApi, type User } from '../api';
import { ActionButton, ErrorText } from '../components';

export function UsersPage() {
  const users = useApi<(User & { createdAt: string })[]>('/users');
  const [form, setForm] = useState({ username: '', displayName: '', password: '', isAdmin: false });
  const [error, setError] = useState<string>();

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', '/users', form);
      setForm({ username: '', displayName: '', password: '', isAdmin: false });
      setError(undefined);
      await users.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section>
      <h1>Users</h1>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Username</th>
            <th>Role</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.data?.map((u) => (
            <tr key={u.id}>
              <td>{u.displayName}</td>
              <td>{u.username}</td>
              <td>{u.isAdmin ? 'Admin' : 'Member'}</td>
              <td>{fmtTime(u.createdAt)}</td>
              <td className="nowrap">
                <ActionButton
                  className="link"
                  onClick={async () => {
                    const password = window.prompt(`New password for ${u.displayName} (8+ characters)`);
                    if (password) await api('PATCH', `/users/${u.id}`, { password });
                  }}
                >
                  Set password
                </ActionButton>
                <ActionButton
                  className="link"
                  confirm={`Delete ${u.displayName}? Their pagers become unclaimed.`}
                  onClick={async () => {
                    await api('DELETE', `/users/${u.id}`);
                    await users.reload();
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
        <h2>Add user</h2>
        <label>
          Display name
          <input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
        </label>
        <label>
          Username
          <input
            value={form.username}
            autoCapitalize="none"
            onChange={(e) => setForm({ ...form, username: e.target.value.toLowerCase() })}
          />
        </label>
        <label>
          Password
          <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </label>
        <label className="check">
          <input type="checkbox" checked={form.isAdmin} onChange={(e) => setForm({ ...form, isAdmin: e.target.checked })} />
          Admin
        </label>
        <div>
          <button type="submit">Add</button>
        </div>
        <ErrorText error={error} />
      </form>
    </section>
  );
}
