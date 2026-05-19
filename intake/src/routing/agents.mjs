/**
 * Cloud agent invocation. Mirrors relay/src/agents.mjs: uses the
 * `openclaw gateway call` CLI as transport against the bridge-service
 * identity. Sticky sessions per agent so context persists across messages.
 *
 * Intake and relay share /opt/data sessions if they're co-located, but in
 * cloud they're separate services with their own session stores. That's
 * fine — Beatrix's openclaw session id can differ per service.
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { log } from '../log.mjs';

let profileDir = '/opt/data';
let gatewayUrl = '';
let gatewayToken = '';
let stateDir = '/opt/data';
let sessions = {};

const OPENCLAW_BIN = process.env.OPENCLAW_BIN ?? 'openclaw';

export function initAgentClient(opts) {
  ({ profileDir, gatewayUrl, gatewayToken, stateDir } = opts);
  mkdirSync(`${stateDir}/intake`, { recursive: true });
  const sessionFile = `${stateDir}/intake/sessions.json`;
  if (existsSync(sessionFile)) {
    try { sessions = JSON.parse(readFileSync(sessionFile, 'utf-8')); }
    catch { sessions = {}; }
  }
  log(`agents: ready (gateway=${gatewayUrl})`);
}

function saveSessions() {
  writeFileSync(`${stateDir}/intake/sessions.json`, JSON.stringify(sessions, null, 2));
}

function openclawCall(method, params, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      `--profile`, 'bridge-service',
      'gateway', 'call',
      '--url', gatewayUrl,
      '--token', gatewayToken,
      '--timeout', String(opts.timeoutMs ?? 60000),
      '--params', JSON.stringify(params),
      '--json',
      method,
    ];
    const env = {
      ...process.env,
      OPENCLAW_STATE_DIR: profileDir,
      OPENCLAW_CONFIG_PATH: `${profileDir}/openclaw.json`,
    };
    const proc = spawn(OPENCLAW_BIN, args, { env, cwd: '/tmp' });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`openclaw ${method} exit=${code}: ${err.trim() || out.trim()}`));
      try { resolve(JSON.parse(out)); }
      catch (e) { reject(new Error(`openclaw ${method} bad JSON: ${out.slice(0, 200)}`)); }
    });
    proc.on('error', reject);
  });
}

async function ensureSession(agentId) {
  if (sessions[agentId]) return sessions[agentId];
  log(`agents: creating session for ${agentId}`);
  const res = await openclawCall('sessions.create', { agentId });
  sessions[agentId] = res.key;
  saveSessions();
  return res.key;
}

export async function invokeAgent(agentId, message) {
  const key = await ensureSession(agentId);

  let preMsgCount = 0;
  try {
    const pre = await openclawCall('sessions.preview', { keys: [key], limit: 200 });
    preMsgCount = pre.previews?.[0]?.items?.length ?? 0;
  } catch (e) {
    log(`(preview pre-send failed: ${e.message})`);
  }

  await openclawCall('sessions.send', { key, message }, { timeoutMs: 30000 });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(2000);
    let preview;
    try {
      preview = await openclawCall('sessions.preview', { keys: [key], limit: 200 });
    } catch (e) {
      log(`(preview poll failed: ${e.message})`);
      continue;
    }
    const items = preview.previews?.[0]?.items ?? [];
    const fresh = items.slice(preMsgCount + 1);
    const assistant = fresh.filter((i) => i.role === 'assistant');
    if (assistant.length > 0 && assistant[assistant.length - 1].text?.trim()) {
      return assistant.map((a) => a.text).join('\n\n');
    }
  }
  throw new Error('agent took longer than 90 seconds; try again');
}
