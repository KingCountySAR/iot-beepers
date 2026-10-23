# Members and channel access

## Users are members
The member database is [cedar](../../../cedar), KCSARA's API over D4H. A user here is a person in it, keyed by their **D4H member id**. Each Google account they sign in with is a login linked to that id, and one member can have several.

**Signing in:** the server looks the Google email up in the member database to find whose it is. An email it doesn't know is refused.
- **First sign-in:** the user is created then. Their name comes from the member database, and nobody is pre-approved.
- **Domains:** if `ALLOWED_DOMAINS` is set (e.g. `kcesar.org`), the account must also be managed by one of those Google Workspace domains. That's the ID token's `hd` claim, not the email's domain, since a personal Google account can be registered with any address. Leave it empty to accept any account the member database knows, personal Gmail included.
- **Database down:** an email that has signed in before still works, using the member it was linked to. A new email gets "try again later".
- **Shared emails:** an email several members share (a family address, say) is refused, since it can't say who signed in.
- **Admins:** a member is an admin if any of their Google accounts is in `SITE_ADMINS`.

**Without a member database** (dev, or before it's connected), each email is its own member, with the email as its id and no groups. If `ALLOWED_DOMAINS` is empty too, only `SITE_ADMINS` can sign in.

## Who can join which channel
A member can subscribe their pagers to a channel if:
- one of their **groups** in the member database is mapped to the channel, or
- an admin gave them a **direct grant** for it. Grants are for members who have already signed in.

Admins can join any channel. Admins manage both lists on the **Access** page. A mapping names a D4H group by its title (matched ignoring case) or its group id; use the id if the title might change or isn't unique.

**When groups are checked:**
- **Sign-in:** groups come back with the member lookup.
- **Viewing or changing channels:** groups are re-checked when a member opens a pager's channel list or saves changes to it, if the last check is older than `MEMBER_GROUPS_MAX_AGE_MIN` (5 min). If the member database is down, the last known groups are used, so nobody gets locked out by an outage.
- **Changing channels:** a member can only add channels they qualify for. They can keep one they already have, for example one an admin set up for them, until the next sync.

**The sync** runs every `MEMBER_SYNC_HOURS` (24), timed from the last run, and on demand with **Sync now**:
1. It asks the member database for the member ids in every mapped group, and updates everyone's groups.
2. It unsubscribes pagers from channels their owners no longer qualify for. Each pager gets its new channel list right away, and each removal is logged on the pager's event list.

If the member database doesn't answer for a group, that group's memberships are left as they were rather than emptied. A failed sync changes nothing, and the Access page shows the error.

Removing a group mapping or a grant takes effect immediately, using the groups last seen: no sync is needed.

## cedar's API
Everything the server knows about cedar lives in [`server/src/memberdb.ts`](../server/src/memberdb.ts). It uses cedar's `/api/v1` routes (see cedar's `API.md`):

| Call | Used for |
| --- | --- |
| `GET /members/:email` | Sign-in: whose Google account this is. 404 is nobody; 409 is several members. |
| `GET /members/:d4hId` | Re-checking a member's groups when they look at or change their channels. |
| `GET /groups/:idOrTitle/members` | The daily sync, once per mapped group. A 404 or 409 (unknown or ambiguous group) leaves that group's members as they were and logs a warning. |

A member's groups are kept by both id and title (e.g. `21` and `ESAR Field`), so either kind of mapping matches.

**Credentials:** cedar takes bearer tokens from its Hydra, with the `members.read` scope. Make a client in the vm repo:
```
node hydra.mjs create oauth2-client --name "SAR Notifier" --grant-type client_credentials --scope members.read --format json
```
Then set:
- `MEMBER_API_URL`: `https://cedar.kingcountysar.org/api/v1`, or `http://cedar:3040/api/v1` from the VM's network.
- `MEMBER_API_TOKEN_URL`: `<Hydra issuer>/oauth2/token`.
- `MEMBER_API_CLIENT_ID` and `MEMBER_API_CLIENT_SECRET`: the new client's.
- `MEMBER_API_SCOPE`: defaults to `members.read`.

Tokens are cached until a minute before they expire, and a 401 gets a new one once. Requests time out after 10 s. cedar reloads from D4H every 5 minutes, so a group change in D4H can take that long to show.
