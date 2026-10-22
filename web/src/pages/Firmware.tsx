import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api, boardName, fmtTime, useApi, type Device, type Firmware, type FirmwareList } from '../api';
import { ActionButton, ErrorText } from '../components';

export function FirmwarePage() {
  const fw = useApi<FirmwareList>('/firmware');
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
      const res = await api<{ board: string; version: string; flashable: boolean }>('POST', '/firmware', form);
      setMessage(
        `Uploaded ${res.version} for ${boardName(res.board)}.` +
          (res.flashable ? '' : ' This was a bare app image, so it can be used for OTA but not the browser flasher.'),
      );
      setError(undefined);
      setNotes('');
      if (fileRef.current) fileRef.current.value = '';
      await fw.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const countOn = (f: Firmware) =>
    devices.data?.filter((d) => d.hwRev === f.board && d.fwVersion === f.version).length ?? 0;

  const byBoard = new Map<string, Firmware[]>();
  for (const f of fw.data?.images ?? []) byBoard.set(f.board, [...(byBoard.get(f.board) ?? []), f]);

  return (
    <section>
      <h1>Firmware</h1>
      <p className="muted">
        Each board has its own builds and its own default. Devices that aren't pinned to a version update to their
        board's default when they connect. Pin one pager to a new build from its device page to test it before making
        it the default. New boards can be flashed from the browser on the <Link to="/flash">Flash</Link> page.
      </p>
      <ErrorText error={fw.error} />
      {fw.data && byBoard.size === 0 && <p className="muted">No firmware uploaded yet.</p>}
      {[...byBoard].map(([board, images]) => {
        const current = fw.data?.defaults[board];
        return (
          <div key={board}>
            <h2>
              {boardName(board)} <span className="muted">· {board}</span>
            </h2>
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
                {images.map((f) => (
                  <tr key={f.version}>
                    <td>
                      <strong>{f.version}</strong>
                      {current === f.version && <span className="pill ok">default</span>}
                      {!f.flashable && <span className="pill warn">OTA only</span>}
                    </td>
                    <td>{fmtTime(f.uploadedAt)}</td>
                    <td>{Math.round(f.size / 1024)} KB</td>
                    <td>{f.idfVersion}</td>
                    <td>{countOn(f)}</td>
                    <td>{f.notes}</td>
                    <td className="nowrap">
                      {current !== f.version && (
                        <ActionButton
                          confirm={`Roll ${f.version} out to every unpinned ${board} device?`}
                          onClick={async () => {
                            const res = await api<{ started: number }>('PUT', '/firmware/default', {
                              board,
                              version: f.version,
                            });
                            setMessage(
                              `${boardName(board)} default set to ${f.version}; ${res.started} online device(s) told to update.`,
                            );
                            await fw.reload();
                          }}
                        >
                          Make default
                        </ActionButton>
                      )}
                      {current !== f.version && (
                        <ActionButton
                          className="link"
                          confirm={`Delete ${f.version} for ${board}?`}
                          onClick={async () => {
                            await api('DELETE', `/firmware/${encodeURIComponent(board)}/${encodeURIComponent(f.version)}`);
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
          </div>
        );
      })}
      {message && <p className="ok-text">{message}</p>}

      <form className="card stack" onSubmit={upload}>
        <h2>Upload a build</h2>
        <p className="muted">
          Run <code>firmware/build.sh &lt;board&gt;</code> and upload <code>firmware/dist/sar-notifier-&lt;board&gt;-&lt;version&gt;.bin</code>.
          The board and version are read from the image. That merged image serves both OTA updates and the browser
          flasher; a bare <code>sar-notifier.bin</code> is accepted too, for OTA only.
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
