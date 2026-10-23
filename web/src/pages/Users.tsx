import { api, fmtTime, timeAgo, useApi, type User } from '../api';
import { ActionButton } from '../components';

type UserRow = Omit<User, 'email'> & {
  createdAt: string;
  groups: string[];
  groupsCheckedAt: string | null;
  logins: { email: string; lastLoginAt: string }[];
};

export function UsersPage() {
  const users = useApi<UserRow[]>('/users');

  return (
    <section>
      <h1>Users</h1>
      <p className="muted">
        Members appear here the first time they sign in. Each is one person in the member database, and can sign in
        with any Google account the database has for them (at one of the server's <code>ALLOWED_DOMAINS</code>, if
        set). Admins are set by <code>SITE_ADMINS</code>. Groups decide which channels people can join (see Access).
      </p>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Member id</th>
            <th>Google accounts</th>
            <th>Role</th>
            <th>Groups</th>
            <th>Since</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.data?.map((u) => (
            <tr key={u.id}>
              <td>{u.displayName}</td>
              <td>
                <code>{u.id}</code>
              </td>
              <td>
                {u.logins.map((l) => (
                  <div key={l.email} title={`Last signed in ${fmtTime(l.lastLoginAt)}`}>
                    {l.email}
                  </div>
                ))}
              </td>
              <td>{u.isAdmin ? 'Admin' : 'Member'}</td>
              <td title={u.groupsCheckedAt ? `Checked ${fmtTime(u.groupsCheckedAt)}` : 'Never checked'}>
                {u.groups.length ? u.groups.join(', ') : <span className="muted">none</span>}
                {u.groupsCheckedAt && <span className="muted"> · {timeAgo(u.groupsCheckedAt)}</span>}
              </td>
              <td>{fmtTime(u.createdAt)}</td>
              <td className="nowrap">
                <ActionButton
                  className="link"
                  confirm={`Remove ${u.displayName}? Their pagers become unclaimed. They come back if they sign in again.`}
                  onClick={async () => {
                    await api('DELETE', `/users/${encodeURIComponent(u.id)}`);
                    await users.reload();
                  }}
                >
                  Remove
                </ActionButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
