/**
 * Calendar (Google Calendar) surface adapter.
 *
 * Uses the same OAuth token store as email (Gmail scopes are requested
 * alongside Calendar scopes so a single click covers both).
 *
 * Watches the primary calendar for new events / updates / cancellations.
 * Routes each event change through intake.
 */

import { existsSync, readFileSync } from 'node:fs';
import { google } from 'googleapis';
import { ingest } from '../pipeline.mjs';
import { log } from '../log.mjs';

let oauth2Client = null;
let lastSyncToken = null;
let pollTimer = null;

export function initCalendar({ stateDir, googleClientId, googleClientSecret, redirectUri }) {
  if (!googleClientId || !googleClientSecret) {
    log('calendar: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing; calendar adapter idle');
    return false;
  }
  oauth2Client = new google.auth.OAuth2(googleClientId, googleClientSecret, redirectUri);

  const tokenPath = `${stateDir}/oauth/gmail.json`; // shared with email
  if (existsSync(tokenPath)) {
    try {
      const tokens = JSON.parse(readFileSync(tokenPath, 'utf-8'));
      oauth2Client.setCredentials(tokens);
      log('calendar: loaded shared OAuth tokens, ready to poll');
      startPolling();
      return true;
    } catch (e) {
      log(`calendar: failed to load tokens (${e.message})`);
    }
  } else {
    log('calendar: no tokens yet; awaiting Omar OAuth click');
  }
  return false;
}

function startPolling() {
  if (pollTimer) return;
  pollOnce().catch((e) => log(`calendar: initial poll failed: ${e.message}`));
  pollTimer = setInterval(() => {
    pollOnce().catch((e) => log(`calendar: poll failed: ${e.message}`));
  }, 60_000);
  log('calendar: polling every 60s');
}

async function pollOnce() {
  if (!oauth2Client) return;
  const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

  const params = {
    calendarId: 'primary',
    singleEvents: true,
    showDeleted: true,
    maxResults: 250,
  };
  if (lastSyncToken) {
    params.syncToken = lastSyncToken;
  } else {
    // First run: incremental sync starts from now. Past events ignored.
    params.timeMin = new Date().toISOString();
  }

  let res;
  try {
    res = await calendar.events.list(params);
  } catch (e) {
    // 410 means our syncToken is stale; rebaseline.
    if (e.code === 410 || /sync token/i.test(e.message)) {
      log('calendar: sync token stale, rebaselining');
      lastSyncToken = null;
      return;
    }
    throw e;
  }

  for (const event of res.data.items ?? []) {
    try {
      const item = normalize(event);
      await ingest(item);
    } catch (e) {
      log(`calendar: failed to handle event ${event.id}: ${e.message}`);
    }
  }

  if (res.data.nextSyncToken) lastSyncToken = res.data.nextSyncToken;
}

export function normalize(event) {
  const start = event.start?.dateTime ?? event.start?.date ?? null;
  const end = event.end?.dateTime ?? event.end?.date ?? null;
  const status = event.status; // 'confirmed' | 'cancelled' | 'tentative'
  const organizer = event.organizer ?? {};
  const attendees = event.attendees ?? [];

  const summary = event.summary ?? '(no title)';
  const description = event.description ?? '';
  const location = event.location ?? '';
  const verb = status === 'cancelled' ? 'cancelled' : (event.created === event.updated ? 'created' : 'updated');

  const text = [
    `${verb}: ${summary}`,
    start ? `When: ${start}${end ? ` to ${end}` : ''}` : null,
    location ? `Where: ${location}` : null,
    attendees.length ? `Attendees: ${attendees.map((a) => a.email).join(', ')}` : null,
    description ? `\n${description}` : null,
  ].filter(Boolean).join('\n');

  return {
    surface: 'calendar',
    receivedAt: new Date(event.updated ?? Date.now()).toISOString(),
    from: {
      identifier: organizer.email ?? 'unknown',
      display: organizer.displayName ?? organizer.email ?? 'unknown',
      kind: organizer.self ? 'self' : 'contact',
    },
    content: {
      subject: summary,
      text,
      rawSurfaceMetadata: {
        event_id: event.id,
        status,
        start,
        end,
        location,
        attendees: attendees.map((a) => ({ email: a.email, responseStatus: a.responseStatus })),
        htmlLink: event.htmlLink,
      },
    },
    hints: {
      suspectedDomain: 'admin',
    },
  };
}
