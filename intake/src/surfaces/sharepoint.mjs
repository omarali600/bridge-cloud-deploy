/**
 * SharePoint surface adapter (Microsoft Graph).
 *
 * Uses Microsoft Graph delta queries against the CRREM SharePoint site's
 * drives. Polls every 5 minutes.
 *
 * Two ways to authenticate:
 *   • App-only (preferred for backend daemon) — requires the daemon to be
 *     registered as an Azure AD app with Sites.Read.All application permission
 *     granted by the tenant admin (Missy Morrow per reference_crrem_admin.md).
 *   • Delegated (per-user) — requires interactive sign-in, refresh token flow.
 *
 * We start with app-only because the daemon is the principal here, not a
 * user. If the admin grant blocks, fall back to delegated using shared
 * Google-OAuth-style flow at /admin/oauth/microsoft/start.
 *
 * Tenant ID, client ID, client secret in env. Reference: feedback /
 * reference_crrem_admin.md
 */

import { ingest } from '../pipeline.mjs';
import { log } from '../log.mjs';

let tenantId = null;
let clientId = null;
let clientSecret = null;
let accessToken = null;
let tokenExpiresAt = 0;
let lastDeltaLinks = {};  // per-drive deltaLink
let pollTimer = null;

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

export function initSharepoint({ tenantId: t, clientId: c, clientSecret: s }) {
  tenantId = t || process.env.MICROSOFT_TENANT_ID || null;
  clientId = c || process.env.MICROSOFT_CLIENT_ID || null;
  clientSecret = s || process.env.MICROSOFT_CLIENT_SECRET || null;

  if (!tenantId || !clientId || !clientSecret) {
    log('sharepoint: MICROSOFT_TENANT_ID / CLIENT_ID / CLIENT_SECRET missing; sharepoint adapter idle');
    return false;
  }
  log('sharepoint: credentials present, starting poll');
  startPolling();
  return true;
}

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt - 30_000) return accessToken;

  const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`sharepoint token: ${res.status} ${t.slice(0, 200)}`);
  }
  const j = await res.json();
  accessToken = j.access_token;
  tokenExpiresAt = Date.now() + j.expires_in * 1000;
  return accessToken;
}

function startPolling() {
  if (pollTimer) return;
  pollOnce().catch((e) => log(`sharepoint: initial poll failed: ${e.message}`));
  pollTimer = setInterval(() => {
    pollOnce().catch((e) => log(`sharepoint: poll failed: ${e.message}`));
  }, 5 * 60_000);
  log('sharepoint: polling every 5 min');
}

async function pollOnce() {
  const token = await getAccessToken();
  // For now we hard-code that we watch the CRREM tenant's drives. A future
  // version reads the sites list dynamically.
  const sitesRes = await fetch(`${GRAPH_BASE}/sites?search=CRREM`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!sitesRes.ok) {
    const t = await sitesRes.text().catch(() => '');
    log(`sharepoint: sites search failed: ${sitesRes.status} ${t.slice(0, 200)}`);
    return;
  }
  const sitesJson = await sitesRes.json();
  for (const site of sitesJson.value ?? []) {
    await pollSite(site, token);
  }
}

async function pollSite(site, token) {
  const drivesRes = await fetch(`${GRAPH_BASE}/sites/${site.id}/drives`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!drivesRes.ok) return;
  const drives = (await drivesRes.json()).value ?? [];

  for (const drive of drives) {
    const key = `${site.id}:${drive.id}`;
    const url = lastDeltaLinks[key] ?? `${GRAPH_BASE}/drives/${drive.id}/root/delta`;
    try {
      const deltaRes = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!deltaRes.ok) {
        const t = await deltaRes.text().catch(() => '');
        log(`sharepoint: delta failed drive=${drive.id}: ${deltaRes.status} ${t.slice(0, 200)}`);
        continue;
      }
      const j = await deltaRes.json();
      for (const it of j.value ?? []) {
        if (it.deleted) continue;
        if (it.folder) continue;
        const item = normalize(it, drive, site);
        await ingest(item);
      }
      if (j['@odata.deltaLink']) lastDeltaLinks[key] = j['@odata.deltaLink'];
      else if (j['@odata.nextLink']) lastDeltaLinks[key] = j['@odata.nextLink'];
    } catch (e) {
      log(`sharepoint: drive ${drive.id} poll error: ${e.message}`);
    }
  }
}

export function normalize(driveItem, drive, site) {
  const lastModified = driveItem.lastModifiedDateTime ?? new Date().toISOString();
  const modifiedBy = driveItem.lastModifiedBy?.user ?? {};
  const path = driveItem.parentReference?.path ?? '';
  const fullPath = `${path}/${driveItem.name}`;

  return {
    surface: 'sharepoint',
    receivedAt: lastModified,
    from: {
      identifier: modifiedBy.email ?? 'unknown',
      display: modifiedBy.displayName ?? modifiedBy.email ?? 'unknown',
      kind: 'contact',
    },
    content: {
      subject: driveItem.name,
      text: `SharePoint file: ${fullPath}\nModified by ${modifiedBy.displayName ?? 'unknown'} at ${lastModified}\nLink: ${driveItem.webUrl ?? ''}`,
      rawSurfaceMetadata: {
        file_id: driveItem.id,
        path: fullPath,
        web_url: driveItem.webUrl,
        site_id: site?.id,
        drive_id: drive?.id,
        size: driveItem.size,
        mime_type: driveItem.file?.mimeType,
      },
    },
    hints: {
      suspectedDomain: 'crrem-internal',
    },
  };
}
