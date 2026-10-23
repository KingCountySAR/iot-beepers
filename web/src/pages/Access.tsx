import { useState, type FormEvent } from 'react';
import { api, fmtTime, timeAgo, useApi, type Channel, type User } from '../api';
import { ActionButton, ErrorText } from '../components';

interface Removal {
  deviceId: string;
  userId: string;
  name: string;
  channel: string;
}

interface SyncStatus {
  at: string;
  ok: boolean;
  error?: string;
  groups: number;
  usersChanged: number;
  removed: Removal[];
}

interface AccessData {
  memberDatabase: boolean;
  syncHours: number;
  lastSync: SyncStatus | null;
  groupChannels: { groupName: string; channelId: number }[];
  grants: { userId: string; name: string; channelId: number; createdAt: string }[];
}

const removedText = (removed: Removal[]) =>
  removed.length === 0
    ? 'no subscriptions removed'
    : `removed ${removed.map((r) => `${r.name} from ${r.channel}`).join(', ')}`;

export function AccessPage() {
  const access = useApi<AccessData>('/access');
  const channels = useApi<Channel[]>('/channels');
  const users = useApi<User[]>('/users');
  const [notice, setNotice] = useState<string>();
  const channelName = (id: number) => channels.data?.find((c) => c.id === id)?.name ?? `#${id}`;
  const a = access.data;

  const remove = async (path: string, body: object) => {
    const { removed } = await api<{ removed: Removal[] }>('DELETE', path, body);
    setNotice(removed.length ? `Done: ${removedText(removed)}.` : undefined);
    await access.reload();
  };

  return (
    <section>
      <h1>Access</h1>
      <p className="muted">
        A member can subscribe their pagers to a channel if one of their member-database groups is mapped to it, or if
        they have a direct grant. Admins can join any channel. Taking access away unsubscribes affected pagers right
        away.
      </p>
      {notice && <div className="callout ok">{notice}</div>}

      <div className="card stack">
        <h2>Member database sync</h2>
        {a && !a.memberDatabase && (
          <p className="muted">
            Not connected (<code>MEMBER_API_URL</code> is unset), so nobody has groups. Only direct grants give access.
          </p>
        )}
        {a && (
          <p>
            Every {a.syncHours} h the server re-reads the members of each mapped group and unsubscribes pagers whose
            owners no longer qualify.{' '}
            {a.lastSync ? (
              <span title={fmtTime(a.lastSync.at)}>
                Last run {timeAgo(a.lastSync.at)}:{' '}
                {a.lastSync.ok ? (
                  `${a.lastSync.groups} groups read, ${a.lastSync.usersChanged} people's groups changed, ${removedText(a.lastSync.removed)}.`
                ) : (
                  <span className="error">failed: {a.lastSync.error}</span>
                )}
              </span>
            ) : (
              'It hasn’t run yet.'
            )}
          </p>
        )}
        <div>
          <ActionButton
            onClick={async () => {
              const s = await api<SyncStatus>('POST', '/access/sync');
              setNotice(s.ok ? `Sync done: ${removedText(s.removed)}.` : undefined);
              await access.reload();
            }}
          >
            Sync now
          </ActionButton>
        </div>
      </div>

      <h2>Groups → channels</h2>
      <table>
        <thead>
          <tr>
            <th>D4H group</th>
            <th>Channel</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {a?.groupChannels.map((g) => (
            <tr key={`${g.groupName}/${g.channelId}`}>
              <td>{g.groupName}</td>
              <td>{channelName(g.channelId)}</td>
              <td>
                <ActionButton
                  className="link"
                  confirm={`Stop letting "${g.groupName}" join ${channelName(g.channelId)}? Members without other access are unsubscribed now.`}
                  onClick={() => remove('/access/groups', g)}
                >
                  Remove
                </ActionButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <AddForm
        title="Map a group"
        field="groupName"
        label="D4H group title (case doesn't matter) or group id. Use the id if the title might change."
        path="/access/groups"
        channels={channels.data}
        onAdded={access.reload}
      />

      <h2>Direct grants</h2>
      <table>
        <thead>
          <tr>
            <th>Member</th>
            <th>Channel</th>
            <th>Granted</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {a?.grants.map((g) => (
            <tr key={`${g.userId}/${g.channelId}`}>
              <td>{g.name}</td>
              <td>{channelName(g.channelId)}</td>
              <td>{fmtTime(g.createdAt)}</td>
              <td>
                <ActionButton
                  className="link"
                  confirm={`Remove ${g.name}'s grant to ${channelName(g.channelId)}? If no group gives them access, their pagers are unsubscribed now.`}
                  onClick={() => remove('/access/grants', { userId: g.userId, channelId: g.channelId })}
                >
                  Remove
                </ActionButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <AddForm
        title="Grant a channel"
        field="userId"
        label="Member (they appear here once they've signed in)"
        users={users.data}
        path="/access/grants"
        channels={channels.data}
        onAdded={access.reload}
      />
    </section>
  );
}

function AddForm(props: {
  title: string;
  field: 'groupName' | 'userId';
  label: string;
  /** Choose from these instead of typing. */
  users?: User[];
  path: string;
  channels: Channel[] | undefined;
  onAdded: () => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [channelId, setChannelId] = useState<number>();
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('POST', props.path, { [props.field]: value, channelId });
      setValue('');
      setError(undefined);
      await props.onAdded();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form className="card stack" onSubmit={submit}>
      <h3>{props.title}</h3>
      <label>
        {props.label}
        {props.users ? (
          <select value={value} onChange={(e) => setValue(e.target.value)}>
            <option value="">Choose…</option>
            {props.users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.displayName}
              </option>
            ))}
          </select>
        ) : (
          <input value={value} autoCapitalize="none" onChange={(e) => setValue(e.target.value)} />
        )}
      </label>
      <label>
        Channel
        <select value={channelId ?? ''} onChange={(e) => setChannelId(Number(e.target.value) || undefined)}>
          <option value="">Choose…</option>
          {props.channels?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      <div>
        <button type="submit" disabled={!value || !channelId}>
          Add
        </button>
      </div>
      <ErrorText error={error} />
    </form>
  );
}
