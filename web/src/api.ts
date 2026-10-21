import { useCallback, useEffect, useState } from 'react';

export interface User {
  id: number;
  username: string;
  displayName: string;
  isAdmin: boolean;
}

export interface Device {
  id: string;
  name: string;
  ownerId: number | null;
  ownerName: string | null;
  claimedAt: string | null;
  createdAt: string;
  online: boolean;
  lastSeenAt: string | null;
  lastConnectAt: string | null;
  fwVersion: string | null;
  fwTarget: string | null;
  hwRev: string | null;
  ip: string | null;
  rssi: number | null;
  uptimeS: number | null;
  freeHeap: number | null;
  armed: boolean | null;
  resetReason: string | null;
  channelIds: number[];
}

export interface DeviceDetail extends Device {
  events: { id: number; at: string; type: string; detail: string }[];
  recentPages: {
    pageId: number;
    title: string;
    body: string;
    createdAt: string;
    sentAt: string | null;
    receivedAt: string | null;
    ackedAt: string | null;
  }[];
}

export interface Channel {
  id: number;
  slug: string;
  name: string;
  description: string;
}

export interface PageSummary {
  id: number;
  channelId: number;
  channelName: string;
  title: string;
  body: string;
  source: string;
  createdAt: string;
  expiresAt: string;
  targets: number;
  received: number;
  acked: number;
}

export interface PageDetail extends Omit<PageSummary, 'channelName' | 'targets' | 'received' | 'acked'> {
  deliveries: {
    deviceId: string;
    deviceName: string;
    ownerName: string | null;
    sentAt: string | null;
    receivedAt: string | null;
    ackedAt: string | null;
  }[];
}

export interface Firmware {
  version: string;
  sha256: string;
  size: number;
  idfVersion: string;
  notes: string;
  uploadedAt: string;
}

export interface Stats {
  devices: { total: number; claimed: number; online: number; armed: number };
  pages: { last24h: number };
  offlineClaimed: { id: string; name: string; ownerName: string; lastSeenAt: string | null }[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method,
    headers: body && !isForm ? { 'content-type': 'application/json' } : undefined,
    body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? data?.message ?? res.statusText);
  return data as T;
}

/** GET a resource, optionally re-polling every `pollMs`. */
export function useApi<T>(path: string | null, pollMs?: number) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();

  const reload = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>('GET', path));
      setError(undefined);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [path]);

  useEffect(() => {
    void reload();
    if (!pollMs) return;
    const t = setInterval(reload, pollMs);
    return () => clearInterval(t);
  }, [reload, pollMs]);

  return { data, error, reload };
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');

export function fmtUptime(s: number | null): string {
  if (s == null) return '—';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
