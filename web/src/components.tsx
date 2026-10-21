import { useState, type ReactNode } from 'react';
import { timeAgo, type Device } from './api';

export function StatusPill({ device }: { device: Pick<Device, 'online' | 'armed' | 'lastSeenAt' | 'ownerId'> }) {
  if (!device.online) return <span className="pill bad">Offline · {timeAgo(device.lastSeenAt)}</span>;
  if (device.ownerId === null) return <span className="pill warn">Unpaired</span>;
  if (device.armed === false) return <span className="pill warn">Quiet</span>;
  return <span className="pill ok">Online</span>;
}

export function Signal({ rssi }: { rssi: number | null }) {
  if (rssi == null) return <>—</>;
  const label = rssi > -60 ? 'good' : rssi > -72 ? 'ok' : 'weak';
  return (
    <span className={`signal ${label}`}>
      {rssi} dBm ({label})
    </span>
  );
}

export function ErrorText({ error }: { error?: string | null }) {
  return error ? <p className="error">{error}</p> : null;
}

/** A button that runs an async action, disables itself while running, and shows errors. */
export function ActionButton({
  onClick,
  children,
  confirm,
  className,
}: {
  onClick: () => Promise<unknown>;
  children: ReactNode;
  confirm?: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <span className="action">
      <button
        className={className}
        disabled={busy}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          setError(undefined);
          try {
            await onClick();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {children}
      </button>
      {error && <span className="error"> {error}</span>}
    </span>
  );
}
