import { useRef, useState, type FormEvent } from 'react';
import { api, fmtTime, useApi, type Device, type Firmware } from '../api';
import { ActionButton, ErrorText } from '../components';

export function FirmwarePage() {
  const fw = useApi<{ default: string | null; images: Firmware[] }>('/firmware');
  const devices = useApi<Device[]>('/devices', 5000);
  const fileRef = useRef<HTMLInputElement>(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    form.append('notes', notes);
    try {
      const res = await api<{ version: string }>('POST', '/firmware', form);
      setMessage(`Uploaded ${res.version}.`);
      setError(undefined);
      setNotes('');
      if (fileRef.current) fileRef.current.value = '';
      await fw.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const countOn = (v: string) => devices.data?.filter((d) => d.fwVersion === v).length ?? 0;

  return (
    <section>
      <h1>Firmware</h1>
      <p className="muted">
        Devices that aren't pinned to a version update to the default when they connect. Pin one pager to a new
        build from its device page to test it before making it the default.
      </p>
      <ErrorText error={fw.error} />
      <table>
        <thead>
          <tr>
            <th>Version</th>
            <th>Uploaded</th>
            <th>Size</th>
            <th>IDF</th>
            <th>Devices</th>
            <th>Notes</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {fw.data?.images.map((f) => (
            <tr key={f.version}>
              <td>
                <strong>{f.version}</strong>
                {fw.data?.default === f.version && <span className="pill ok">default</span>}
              </td>
              <td>{fmtTime(f.uploadedAt)}</td>
              <td>{Math.round(f.size / 1024)} KB</td>
              <td>{f.idfVersion}</td>
              <td>{countOn(f.version)}</td>
              <td>{f.notes}</td>
              <td className="nowrap">
                {fw.data?.default !== f.version && (
                  <ActionButton
                    confirm={`Roll ${f.version} out to every unpinned device?`}
                    onClick={async () => {
                      const res = await api<{ started: number }>('PUT', '/firmware/default', { version: f.version });
                      setMessage(`Default set to ${f.version}; ${res.started} online device(s) told to update.`);
                      await fw.reload();
                    }}
                  >
                    Make default
                  </ActionButton>
                )}
                {fw.data?.default !== f.version && (
                  <ActionButton
                    className="link"
                    confirm={`Delete ${f.version}?`}
                    onClick={async () => {
                      await api('DELETE', `/firmware/${encodeURIComponent(f.version)}`);
                      await fw.reload();
                    }}
                  >
                    Delete
                  </ActionButton>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {message && <p className="ok-text">{message}</p>}

      <form className="card stack" onSubmit={upload}>
        <h2>Upload a build</h2>
        <p className="muted">
          Upload <code>firmware/build/sar-notifier.bin</code>. The version is read from the image.
        </p>
        <input type="file" accept=".bin" ref={fileRef} />
        <label>
          Notes
          <input value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        <div>
          <button type="submit">Upload</button>
        </div>
        <ErrorText error={error} />
      </form>
    </section>
  );
}
