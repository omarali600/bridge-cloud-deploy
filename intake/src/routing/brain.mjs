/**
 * Brain write. Uses the gbrain-http service when GBRAIN_HTTP_URL is set,
 * otherwise spawns gbrain CLI locally.
 *
 * Brain layout: intake items land under `inbox/<date>/<surface>-<slug>` so
 * Omar can scan a day's capture in one folder.
 */

import { spawn } from 'node:child_process';
import { log } from '../log.mjs';

let httpUrl = null;
let httpToken = null;
let gbrainBin = 'gbrain';

export function initBrainClient({ httpUrl: u, httpToken: t, gbrainBin: g } = {}) {
  httpUrl = u || process.env.GBRAIN_HTTP_URL || null;
  httpToken = t || process.env.GBRAIN_HTTP_TOKEN || null;
  if (g) gbrainBin = g;
  log(`brain: ${httpUrl ? `HTTP=${httpUrl}` : `CLI=${gbrainBin}`}`);
}

export async function writeToBrain(slug, content) {
  if (httpUrl) {
    return writeViaHttp(slug, content);
  }
  return writeViaCli(slug, content);
}

async function writeViaHttp(slug, content) {
  const url = `${httpUrl.replace(/\/$/, '')}/put`;
  const headers = { 'Content-Type': 'application/json' };
  if (httpToken) headers['Authorization'] = `Bearer ${httpToken}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ slug, content }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`gbrain-http put ${slug} failed: ${res.status} ${body.slice(0, 200)}`);
  }
  log(`brain: put ${slug} via HTTP (${content.length}b)`);
  return { slug, via: 'http' };
}

function writeViaCli(slug, content) {
  return new Promise((resolve, reject) => {
    const proc = spawn(gbrainBin, ['put', slug], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.stdin.write(content);
    proc.stdin.end();
    proc.on('close', (code) => {
      if (code === 0) {
        log(`brain: put ${slug} via CLI (${content.length}b)`);
        resolve({ slug, via: 'cli' });
      } else {
        reject(new Error(`gbrain put ${slug} exit=${code}: ${err.trim()}`));
      }
    });
    proc.on('error', reject);
  });
}
