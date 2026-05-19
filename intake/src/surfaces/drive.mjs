/**
 * Drive (Google Drive) surface adapter.
 *
 * Polls changes.list() against the user's Drive every 90s. Uses the same
 * OAuth token as email/calendar.
 *
 * Alternative: Drive change notifications (webhook). They require a verified
 * domain, have a 7-day TTL that must be renewed, and need an HTTPS endpoint
 * we control. Polling is simpler for now; we can add push later if rates
 * become a problem (free tier is generous).
 */

import { existsSync, readFileSync } from 'node:fs';
import { google } from 'googleapis';
import { ingest } from '../pipeline.mjs';
import { log } from '../log.mjs';

let oauth2Client = null;
let lastPageToken = null;
let pollTimer = null;

export function initDrive({ stateDir, googleClientId, googleClientSecret, redirectUri }) {
  if (!googleClientId || !googleClientSecret) {
    log('drive: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing; drive adapter idle');
    return false;
  }
  oauth2Client = new google.auth.OAuth2(googleClientId, googleClientSecret, redirectUri);

  const tokenPath = `${stateDir}/oauth/gmail.json`;
  if (existsSync(tokenPath)) {
    try {
      const tokens = JSON.parse(readFileSync(tokenPath, 'utf-8'));
      oauth2Client.setCredentials(tokens);
      log('drive: loaded shared OAuth tokens, ready to poll');
      startPolling();
      return true;
    } catch (e) {
      log(`drive: failed to load tokens (${e.message})`);
    }
  } else {
    log('drive: no tokens yet; awaiting Omar OAuth click');
  }
  return false;
}

function startPolling() {
  if (pollTimer) return;
  pollOnce().catch((e) => log(`drive: initial poll failed: ${e.message}`));
  pollTimer = setInterval(() => {
    pollOnce().catch((e) => log(`drive: poll failed: ${e.message}`));
  }, 90_000);
  log('drive: polling every 90s');
}

async function pollOnce() {
  if (!oauth2Client) return;
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  if (!lastPageToken) {
    const tokenRes = await drive.changes.getStartPageToken();
    lastPageToken = tokenRes.data.startPageToken;
    log(`drive: baseline pageToken=${lastPageToken}`);
    return;
  }

  const res = await drive.changes.list({
    pageToken: lastPageToken,
    fields: 'changes(file(id,name,mimeType,modifiedTime,parents,webViewLink,owners,size,createdTime), removed, fileId, time, changeType), newStartPageToken, nextPageToken',
    pageSize: 100,
  });

  for (const change of res.data.changes ?? []) {
    try {
      if (change.removed) continue; // skip deletions for now
      const file = change.file;
      if (!file) continue;
      if (file.mimeType === 'application/vnd.google-apps.folder') continue;

      const item = normalize(file, change);
      await ingest(item);
    } catch (e) {
      log(`drive: failed to handle change ${change.fileId}: ${e.message}`);
    }
  }

  if (res.data.newStartPageToken) lastPageToken = res.data.newStartPageToken;
  else if (res.data.nextPageToken) lastPageToken = res.data.nextPageToken;
}

export function normalize(file, change) {
  const owner = file.owners?.[0] ?? {};
  return {
    surface: 'drive',
    receivedAt: change.time ? new Date(change.time).toISOString() : new Date().toISOString(),
    from: {
      identifier: owner.emailAddress ?? 'unknown',
      display: owner.displayName ?? owner.emailAddress ?? 'unknown',
      kind: owner.me ? 'self' : 'contact',
    },
    content: {
      subject: file.name,
      text: `New file in Drive: ${file.name} (${file.mimeType})\nOwner: ${owner.displayName ?? owner.emailAddress ?? 'unknown'}\nLink: ${file.webViewLink ?? ''}`,
      rawSurfaceMetadata: {
        file_id: file.id,
        mime_type: file.mimeType,
        web_view_link: file.webViewLink,
        modified_time: file.modifiedTime,
        size: file.size,
        parents: file.parents,
      },
    },
    hints: {},
  };
}
