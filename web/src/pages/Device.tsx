import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { api, boardName, fmtTime, fmtUptime, timeAgo, useApi, type Channel, type DeviceDetail, type FirmwareList } from '../api';
import { useAuth } from '../App';
import { ActionButton, ErrorText, Signal, StatusPill } from '../components';

export function DevicePage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const device = useApi<DeviceDetail>(`/devices/${id}`, 5000);
  const channels = useApi<Channel[]>('/channels');
  const fw = useApi<FirmwareList>(user?.isAdmin ? '/firmware' : null);

  const [name, setName] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [dirty, setDirty] = useState(false);
  const d = device.data;

  // Sync the form from the server until the user starts editing.
  useEffect(() => {
    if (d && !dirty) {
      setName(d.name);
      setSelected(d.channelIds);
    }
  }, [d, dirty]);

  if (device.error) return <ErrorText error={device.error} />;
  if (!d) return null;

  const command = (cmd: string) => api('POST', `/devices/${d.id}/command`, { cmd });
  const save = async () => {
    await api('PATCH', `/devices/${d.id}`, { name, channelIds: selected });
    setDirty(false);
    await device.reload();
  };
  const toggle = (chId: number) => {
    setDirty(true);
    setSelected((s) => (s.includes(chId) ? s.filter((x) => x !== chId) : [...s, chId]));
  };

  return (
    <section>
      <p>
        <Link to="/">← All pagers</Link>
      </p>
      {params.get('paired') && (
        <div className="callout ok">Paired! Choose the channels this pager should alarm for, then save.</div>
      )}
      <div className="row">
        <h1>{d.name || d.id}</h1>
        <StatusPill device={d} />
      </div>

      <div className="grid2">
        <div className="card">
          <h2>Settings</h2>
          <div className="stack">
            <label>
              Name
              <input
                value={name}
                onChange={(e) => {
                  setDirty(true);
                  setName(e.target.value);
                }}
              />
            </label>
            <fieldset>
              <legend>Channels</legend>
              {channels.data?.length === 0 && <p className="muted">No channels have been created yet.</p>}
              {channels.data?.map((ch) => (
                <label key={ch.id} className="check">
                  <input type="checkbox" checked={selected.includes(ch.id)} onChange={() => toggle(ch.id)} />
                  {ch.name}
                  {ch.description && <span className="muted"> — {ch.description}</span>}
                </label>
              ))}
            </fieldset>
            <div>
              <ActionButton onClick={save}>Save</ActionButton>
            </div>
          </div>
        </div>

        <div className="card">
          <h2>Status</h2>
          <dl>
            <dt>Owner</dt>
            <dd>{d.ownerName ?? 'unclaimed'}</dd>
            <dt>Alarm switch</dt>
            <dd>{d.armed == null ? '—' : d.armed ? 'Armed' : 'Quiet (LED only)'}</dd>
            <dt>Signal</dt>
            <dd>
              <Signal rssi={d.rssi} />
            </dd>
            <dt>Last seen</dt>
            <dd title={fmtTime(d.lastSeenAt)}>{timeAgo(d.lastSeenAt)}</dd>
            <dt>Connected since</dt>
            <dd>{d.online ? fmtTime(d.lastConnectAt) : '—'}</dd>
            <dt>Uptime</dt>
            <dd>{fmtUptime(d.uptimeS)}</dd>
            <dt>Firmware</dt>
            <dd>
              {d.fwVersion ?? '—'} {d.hwRev && <span className="muted">({boardName(d.hwRev)})</span>}
            </dd>
            <dt>IP</dt>
            <dd>{d.ip ?? '—'}</dd>
            <dt>Free heap</dt>
            <dd>{d.freeHeap != null ? `${Math.round(d.freeHeap / 1024)} KB` : '—'}</dd>
            <dt>Last reset</dt>
            <dd>{d.resetReason ?? '—'}</dd>
            <dt>Device ID</dt>
            <dd>
              <code>{d.id}</code>
            </dd>
          </dl>
          <div className="row wrap">
            <ActionButton onClick={() => command('test')}>Test alarm</ActionButton>
            <ActionButton onClick={() => command('identify')}>Blink LED</ActionButton>
            <ActionButton onClick={() => command('reboot')} confirm="Reboot this pager?">
              Reboot
            </ActionButton>
          </div>
        </div>
      </div>

      {user?.isAdmin && fw.data && (
        <div className="card">
          <h2>Firmware target</h2>
          {d.hwRev ? (
            <>
              <p className="muted">
                Leave on default to follow the rollout for {boardName(d.hwRev)} (
                {fw.data.defaults[d.hwRev] ?? 'none set'}), or pin this device to a version — useful for trying a
                release on one pager first.
              </p>
              <select
                value={d.fwTarget ?? ''}
                onChange={async (e) => {
                  await api('PUT', `/devices/${d.id}/firmware-target`, { version: e.target.value || null });
                  await device.reload();
                }}
              >
                <option value="">Default</option>
                {fw.data.images
                  .filter((f) => f.board === d.hwRev)
                  .map((f) => (
                    <option key={f.version} value={f.version}>
                      {f.version}
                    </option>
                  ))}
              </select>
            </>
          ) : (
            <p className="muted">This pager hasn't reported its board, so it won't be sent updates.</p>
          )}
        </div>
      )}

      <div className="card">
        <h2>Recent pages</h2>
        {d.recentPages.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Page</th>
                <th>Sent</th>
                <th>Received</th>
                <th>Acknowledged</th>
              </tr>
            </thead>
            <tbody>
              {d.recentPages.map((p) => (
                <tr key={p.pageId}>
                  <td>
                    <Link to={`/pages/${p.pageId}`}>{p.title || p.body.slice(0, 60)}</Link>
                  </td>
                  <td>{fmtTime(p.sentAt)}</td>
                  <td>{fmtTime(p.receivedAt)}</td>
                  <td>{fmtTime(p.ackedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="card">
        <h2>Event log</h2>
        <table className="compact">
          <tbody>
            {d.events.map((e) => (
              <tr key={e.id}>
                <td className="nowrap">{fmtTime(e.at)}</td>
                <td>{e.type}</td>
                <td className="muted">{e.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card danger">
        <h2>Danger zone</h2>
        <div className="row wrap">
          {d.ownerId !== null && (
            <ActionButton
              confirm="Release this pager? It will stop receiving pages until it is paired again."
              onClick={async () => {
                await api('POST', `/devices/${d.id}/release`);
                navigate('/');
              }}
            >
              Release pager
            </ActionButton>
          )}
          {user?.isAdmin && (
            <>
              <ActionButton
                confirm="Reset this device? Its identity is forgotten so it can re-register after a flash erase."
                onClick={async () => {
                  await api('POST', `/devices/${d.id}/reset`);
                  await device.reload();
                }}
              >
                Reset identity
              </ActionButton>
              <ActionButton
                confirm="Delete this device and its history?"
                onClick={async () => {
                  await api('DELETE', `/devices/${d.id}`);
                  navigate('/');
                }}
              >
                Delete
              </ActionButton>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
