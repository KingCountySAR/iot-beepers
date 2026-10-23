import type { Config } from './config.js';

/**
 * The team's member database: who our members are, which Google accounts are theirs, and
 * which groups they belong to. Users here are keyed by its member id, and group membership
 * decides which channels a member may subscribe their pagers to (access.ts).
 *
 * It's cedar (../../cedar, API.md there), which models the team from D4H. Member ids are D4H
 * member ids. Groups are D4H groups, named here by D4H group id or title, so an admin can map
 * either to a channel.
 */
export interface Member {
  id: string;
  name: string;
  /** Each group by id and by title, e.g. ["21", "ESAR Field"]. */
  groups: string[];
}

export interface MemberDirectory {
  /** The member a Google account email belongs to, or null if it's nobody's. */
  findByEmail(email: string): Promise<Member | null>;
  /** One member by id, or null if they're gone. */
  get(id: string): Promise<Member | null>;
  /**
   * Member ids in each named group (an id or a title). A group missing from the result is
   * treated as unknown (its members are left as they were), never as empty.
   */
  membersOf(groups: string[]): Promise<Map<string, string[]>>;
}

/** Several members share the email (e.g. a family address), so it can't say who signed in. */
export class AmbiguousEmail extends Error {}

type MemberApiConfig = Pick<
  Config,
  'MEMBER_API_URL' | 'MEMBER_API_TOKEN_URL' | 'MEMBER_API_CLIENT_ID' | 'MEMBER_API_CLIENT_SECRET' | 'MEMBER_API_SCOPE'
>;

const TIMEOUT_MS = 10_000;

export function createMemberDirectory(cfg: MemberApiConfig): MemberDirectory | null {
  return cfg.MEMBER_API_URL ? new CedarDirectory(cfg) : null;
}

/** cedar's /api/v1 Member, as far as we use it. */
interface CedarMember {
  d4hId: number;
  name: { full: string };
  groups?: { groupId: number; title: string }[];
}

class CedarDirectory implements MemberDirectory {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly base: string;

  constructor(private cfg: MemberApiConfig) {
    this.base = cfg.MEMBER_API_URL!.replace(/\/+$/, '');
  }

  /** GET /members/:email; 404 = nobody, 409 = shared by several members. */
  async findByEmail(email: string) {
    const res = await this.request(`/members/${encodeURIComponent(email)}`);
    if (res.status === 409) throw new AmbiguousEmail(`${email} belongs to several members`);
    return this.member(res);
  }

  /** GET /members/:d4hId */
  async get(id: string) {
    if (!/^\d+$/.test(id)) return null; // e.g. a dev account keyed by email
    return this.member(await this.request(`/members/${id}`));
  }

  /** GET /groups/:idOrTitle/members, for each group. */
  async membersOf(groups: string[]) {
    const result = new Map<string, string[]>();
    for (const group of groups) {
      const res = await this.request(`/groups/${encodeURIComponent(group)}/members`);
      if (res.status === 404 || res.status === 409) {
        // A typo or a renamed group, or a title that's no longer unique: leave its members as they were.
        console.warn(`Member database: group "${group}": ${res.status} ${(await res.text()).slice(0, 200)}`);
        continue;
      }
      const body = (await this.json(res)) as { results?: { d4hId: number }[] };
      result.set(group, (body.results ?? []).map((m) => String(m.d4hId)));
    }
    return result;
  }

  private async member(res: Response): Promise<Member | null> {
    if (res.status === 404) return null;
    const m = (await this.json(res)) as CedarMember;
    if (typeof m.d4hId !== 'number') throw new Error(`member API ${res.url}: no d4hId in the response`);
    return {
      id: String(m.d4hId),
      name: m.name?.full ?? '',
      groups: (m.groups ?? []).flatMap((g) => [String(g.groupId), g.title]),
    };
  }

  private async request(path: string, retried = false): Promise<Response> {
    const res = await fetch(this.base + path, {
      headers: { authorization: `Bearer ${await this.accessToken()}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401 && !retried) {
      this.token = null; // revoked or expired early
      return this.request(path, true);
    }
    return res;
  }

  private async json(res: Response) {
    if (!res.ok) throw new Error(`member API ${res.url}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  /**
   * OAuth 2.0 client credentials from cedar's Hydra, cached until a minute before it expires.
   * Hydra's clients authenticate with HTTP Basic (client_secret_basic) unless made otherwise, so
   * the id and secret go in the Authorization header, each form-encoded first (RFC 6749 2.3.1).
   */
  private async accessToken() {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const basic = [this.cfg.MEMBER_API_CLIENT_ID!, this.cfg.MEMBER_API_CLIENT_SECRET!].map(encodeURIComponent).join(':');
    const res = await fetch(this.cfg.MEMBER_API_TOKEN_URL!, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(basic).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        ...(this.cfg.MEMBER_API_SCOPE ? { scope: this.cfg.MEMBER_API_SCOPE } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`member API token: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const { access_token, expires_in } = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = { value: access_token, expiresAt: Date.now() + ((expires_in ?? 3600) - 60) * 1000 };
    return access_token;
  }
}
