import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { boardName, fmtTime, useApi, type FlashBoard } from '../api';
import { ErrorText } from '../components';

type Phase = 'idle' | 'connecting' | 'flashing' | 'done';

type Part = 'bootloader' | 'partition-table' | 'app';
const PART_LABELS = ['bootloader', 'partition table', 'boot selector', 'firmware'];

/** "ESP32-C3" (esptool-js) -> "esp32c3" (the server's chip names). */
const chipKey = (name: string) => name.toLowerCase().replace(/-/g, '');

/** Full speed first, then a slow retry. */
const BAUD_RATES = [460800, 115200];

class WrongChipError extends Error {}

async function fetchPart(board: string, version: string, part: Part) {
  const res = await fetch(`/api/flash/${encodeURIComponent(board)}/${encodeURIComponent(version)}/${part}`);
  if (!res.ok) throw new Error(`Couldn't download the ${part} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Flash a pager over USB from the browser (Web Serial + esptool-js). Writes the bootloader,
 * partition table, a blank boot selector and the app, but not NVS, so a reflashed pager
 * keeps its Wi-Fi settings and identity unless "erase everything" is ticked.
 */
export function FlashPage() {
  const flashInfo = useApi<{ publicUrl: string; boards: FlashBoard[] }>('/flash');
  const boards = { data: flashInfo.data?.boards, error: flashInfo.error };
  const [board, setBoard] = useState('');
  const [version, setVersion] = useState('');
  const [eraseAll, setEraseAll] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<{ label: string; pct: number }>();
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [deviceId, setDeviceId] = useState<string>();

  const supported = window.isSecureContext && 'serial' in navigator;
  const selected = boards.data?.find((b) => b.board === board);

  // Pick the first board, then that board's default (or newest) version.
  useEffect(() => {
    if (!board && boards.data?.[0]) setBoard(boards.data[0].board);
  }, [boards.data, board]);
  useEffect(() => {
    if (selected) setVersion(selected.default ?? selected.images[0]?.version ?? '');
  }, [selected]);

  // "Writing at 0x…" arrives for every block; the progress bar covers it.
  const append = (line: string) => {
    if (!line.startsWith('Writing at')) setLog((l) => [...l.slice(-200), line]);
  };

  const flash = async () => {
    if (!selected) return;
    const image = selected.images.find((i) => i.version === version);
    if (!image) return;
    setError(undefined);
    setNotice(undefined);
    setDeviceId(undefined);
    setLog([]);
    setProgress(undefined);

    // requestPort must run straight from the click, before any other await.
    let port: SerialPort;
    try {
      port = await navigator.serial.requestPort();
    } catch {
      return; // chooser cancelled
    }

    setPhase('connecting');
    try {
      const part = (p: Part) => fetchPart(selected.board, image.version, p);
      const [bootloader, partitionTable, app] = await Promise.all([
        part('bootloader'),
        part('partition-table'),
        part('app'),
      ]);
      const { layout } = image;
      const files = [
        { data: bootloader, address: layout.bootloaderOffset },
        { data: partitionTable, address: layout.partitionTableOffset },
        // Blank otadata makes the bootloader start the app we just wrote to ota_0.
        { data: new Uint8Array(layout.otadataSize).fill(0xff), address: layout.otadataOffset },
        { data: app, address: layout.appOffset },
      ];

      // A transfer can fail on some USB-serial setups at full speed; the slow retry is ~4x slower.
      let lastError: unknown;
      for (const baudrate of BAUD_RATES) {
        try {
          const mac = await flashOnce(port, baudrate, files);
          setDeviceId(mac.replace(/:/g, '').toLowerCase());
          setPhase('done');
          return;
        } catch (err) {
          if (err instanceof WrongChipError) throw err;
          lastError = err;
          append(`Failed at ${baudrate} baud: ${(err as Error).message}`);
          setNotice(`That didn't work at full speed (${(err as Error).message}). Retrying more slowly…`);
          setPhase('connecting');
        }
      }
      throw lastError;
    } catch (err) {
      setNotice(undefined);
      setError(
        `${(err as Error).message || String(err)}. Unplug the board, plug it back in and try again; ` +
          'if it keeps failing, try another cable or USB port.',
      );
      setPhase('idle');
    }
  };

  /** One full connect / write / verify / reset pass. Returns the chip's MAC address. */
  const flashOnce = async (port: SerialPort, baudrate: number, fileArray: { data: Uint8Array; address: number }[]) => {
    if (!selected) throw new Error('No board selected');
    const [{ ESPLoader, Transport }, { default: SparkMD5 }] = await Promise.all([
      import('esptool-js'),
      import('spark-md5'),
    ]);
    const transport = new Transport(port, false);
    try {
      const loader = new ESPLoader({
        transport,
        baudrate,
        terminal: { clean: () => {}, writeLine: append, write: append },
      });
      await loader.main();
      if (chipKey(loader.chip.CHIP_NAME) !== selected.chip) {
        throw new WrongChipError(
          `This board is an ${loader.chip.CHIP_NAME}, but ${boardName(selected.board)} firmware is for ${selected.chip}. Pick the right board above`,
        );
      }
      const mac = await loader.chip.readMac(loader);
      setPhase('flashing');
      await loader.writeFlash({
        fileArray,
        flashMode: 'keep',
        flashFreq: 'keep',
        flashSize: 'keep',
        eraseAll,
        compress: true,
        // Read each part's MD5 back from flash, so a bad transfer can't pass silently.
        calculateMD5Hash: (data) => SparkMD5.ArrayBuffer.hash(data.slice().buffer),
        reportProgress: (i, written, total) =>
          setProgress({ label: PART_LABELS[i] ?? '', pct: Math.round((written / total) * 100) }),
      });
      await loader.after('hard_reset');
      return mac;
    } finally {
      await transport.disconnect().catch(() => {});
    }
  };

  const busy = phase === 'connecting' || phase === 'flashing';

  return (
    <section>
      <h1>Flash a pager</h1>
      <p className="muted">
        Install the pager firmware on a new board over USB, straight from this page. After this, updates arrive over
        Wi-Fi.
      </p>

      {!supported && (
        <div className="callout warn">
          This browser can't talk to USB devices. Use Chrome or Edge on a computer, and open this site over{' '}
          <code>https://</code> (or <code>http://localhost</code>).
        </div>
      )}
      <ErrorText error={boards.error} />
      {boards.data?.length === 0 && (
        <p className="muted">
          No flashable firmware yet. An admin needs to upload a build from <code>firmware/build.sh</code> on the{' '}
          <Link to="/firmware">Firmware</Link> page.
        </p>
      )}

      {boards.data && boards.data.length > 0 && (
        <div className="card stack">
          <label>
            Board
            <select value={board} onChange={(e) => setBoard(e.target.value)} disabled={busy}>
              {boards.data.map((b) => (
                <option key={b.board} value={b.board}>
                  {boardName(b.board)}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <label>
              Version
              <select value={version} onChange={(e) => setVersion(e.target.value)} disabled={busy}>
                {selected.images.map((i) => (
                  <option key={i.version} value={i.version}>
                    {i.version}
                    {i.version === selected.default ? ' (default)' : ''} · {fmtTime(i.uploadedAt)}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={eraseAll} onChange={(e) => setEraseAll(e.target.checked)} disabled={busy} />
            Erase everything first
          </label>
          <p className="muted">
            Tick this for a board that has run other firmware. Don't tick it for a pager that's already paired: it
            wipes the pager's identity, and an admin will have to <strong>Reset</strong> it before it can reconnect.
          </p>
          <ol className="muted">
            <li>Plug the board into this computer with a USB data cable.</li>
            <li>
              Click <strong>Connect and flash</strong> and pick its port (e.g. <em>USB JTAG/serial debug unit</em> for
              the XIAO, or <em>CP210x</em> / <em>CH340</em> for a DevKit).
            </li>
            <li>
              If it won't connect, hold the board's <strong>BOOT</strong> button while plugging it in, then try again.
            </li>
          </ol>
          <div>
            <button onClick={flash} disabled={!supported || busy || !version}>
              {phase === 'connecting' ? 'Connecting…' : phase === 'flashing' ? 'Flashing…' : 'Connect and flash'}
            </button>
          </div>
          {progress && phase === 'flashing' && (
            <div>
              <progress max={100} value={progress.pct} /> Writing {progress.label}… {progress.pct}%
            </div>
          )}
          {notice && <p className="muted">{notice}</p>}
          <ErrorText error={error} />
        </div>
      )}

      {phase === 'done' && deviceId && (
        <div className="callout ok">
          <p>
            <strong>Done.</strong> Pager <code>{deviceId}</code> is restarting into setup mode.
          </p>
          <p>
            Join the <strong>SAR-Pager-{deviceId.slice(-4)}</strong> Wi-Fi network from your phone, enter your home
            Wi-Fi and the server address <code>{flashInfo.data?.publicUrl}</code>, then{' '}
            <Link to="/pair">pair it</Link> with the code it shows.
          </p>
        </div>
      )}

      {log.length > 0 && (
        <details>
          <summary>Flasher log</summary>
          <pre className="log">{log.join('\n')}</pre>
        </details>
      )}
    </section>
  );
}
