import { Link } from 'react-router';
import { timeAgo, useApi, type Device, type Stats } from '../api';
import { useAuth } from '../App';
import { ErrorText, Signal, StatusPill } from '../components';

export function DashboardPage() {
  const { user } = useAuth();
  const devices = useApi<Device[]>('/devices', 5000);
  const stats = useApi<Stats>(user?.isAdmin ? '/stats' : null, 5000);

  return (
    <section>
      {stats.data && (
        <div className="tiles">
          <Tile label="Online" value={`${stats.data.devices.online} / ${stats.data.devices.total}`} />
          <Tile label="Armed" value={stats.data.devices.armed} />
          <Tile label="Paired" value={stats.data.devices.claimed} />
          <Tile label="Pages (24h)" value={stats.data.pages.last24h} />
        </div>
      )}

      {stats.data && stats.data.offlineClaimed.length > 0 && (
        <div className="callout warn">
          <strong>Paired pagers that are offline:</strong>{' '}
          {stats.data.offlineClaimed.map((d, i) => (
            <span key={d.id}>
              {i > 0 && ', '}
              <Link to={`/devices/${d.id}`}>{d.ownerName}</Link> ({timeAgo(d.lastSeenAt)})
            </span>
          ))}
        </div>
      )}

      <div className="row">
        <h1>{user?.isAdmin ? 'Devices' : 'My pagers'}</h1>
        <span className="spacer" />
        <Link to="/pair" className="button">
          Pair a pager
        </Link>
      </div>
      <ErrorText error={devices.error} />
      {devices.data?.length === 0 && (
        <p className="muted">
          No pagers yet. Plug one in, join its <code>SAR-Pager-xxxx</code> Wi-Fi network, and follow the setup page.
        </p>
      )}
      {devices.data && devices.data.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              {user?.isAdmin && <th>Owner</th>}
              <th>Status</th>
              <th>Signal</th>
              <th>Firmware</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {devices.data.map((d) => (
              <tr key={d.id}>
                <td>
                  <Link to={`/devices/${d.id}`}>{d.name || d.id}</Link>
                </td>
                {user?.isAdmin && <td>{d.ownerName ?? <span className="muted">unclaimed</span>}</td>}
                <td>
                  <StatusPill device={d} />
                </td>
                <td>
                  <Signal rssi={d.rssi} />
                </td>
                <td>
                  {d.fwVersion ?? '—'}
                  {d.fwTarget && d.fwTarget !== d.fwVersion && <span className="muted"> → {d.fwTarget}</span>}
                </td>
                <td>{timeAgo(d.lastSeenAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="tile">
      <div className="tile-value">{value}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}
