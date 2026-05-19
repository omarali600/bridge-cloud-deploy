import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import twilio from 'twilio';
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.VOICE_AGENT_PORT || 8765);
const HOST = process.env.VOICE_AGENT_HOST || '0.0.0.0';
const PUBLIC_BASE_URL = process.env.VOICE_AGENT_PUBLIC_URL
  || (process.env.NGROK_DOMAIN ? `https://${process.env.NGROK_DOMAIN}` : '');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_REALTIME_MODEL = process.env.VOICE_AGENT_OPENAI_MODEL || 'gpt-realtime';
const OPENAI_SUMMARY_MODEL = process.env.VOICE_AGENT_SUMMARY_MODEL || 'gpt-4.1-mini';
const VOICE = process.env.VOICE_AGENT_VOICE || 'marin';
const BRAIN_ROOT = process.env.BRAIN_REPO_PATH || '/Users/omar/brain';
const GBRAIN_REPO = process.env.GBRAIN_REPO_PATH || '/Users/omar/Desktop/Agents/gbrain';
const GBRAIN_BUN = process.env.GBRAIN_BUN_PATH || '/Users/omar/.bun/bin/bun';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const SKIP_TWILIO_SIGNATURE = process.env.VOICE_AGENT_SKIP_TWILIO_SIGNATURE === '1';
const OWNER_PHONE = normalizePhone(process.env.VOICE_AGENT_OWNER_PHONE || '');
const LOG_DIR = process.env.VOICE_AGENT_LOG_DIR || '/Users/omar/.gbrain/logs';
const TOOL_TIMEOUT_MS = Number(process.env.VOICE_AGENT_TOOL_TIMEOUT_MS || 20000);
const IMPORT_TIMEOUT_MS = Number(process.env.VOICE_AGENT_IMPORT_TIMEOUT_MS || 120000);
const REMOTE_MCP_INTERNAL_URL = process.env.REMOTE_MCP_INTERNAL_URL || `http://127.0.0.1:${process.env.REMOTE_MCP_PORT || 8787}`;

mkdirSync(LOG_DIR, { recursive: true });

const callSessions = new Map();

function normalizePhone(value) {
  return value.replace(/[^\d+]/g, '');
}

function sanitizeForTwilio(text) {
  return text
    .replace(/[\u2014\u2013]/g, '--')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2192/g, '->')
    .replace(/\u2190/g, '<-')
    .replace(/[\u2026]/g, '...')
    .replace(/[^\x00-\x7F]/g, '');
}

function scrubPii(text) {
  return text
    .replace(/\+?\d[\d\s\-().]{7,}\d/g, '[redacted phone]')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[redacted email]')
    .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted key]')
    .replace(/sbp_[A-Za-z0-9]+/g, '[redacted token]');
}

function slugPartFromCaller(caller) {
  const digits = caller.replace(/\D/g, '');
  if (!digits) return 'unknown';
  return digits.length <= 4 ? digits : digits.slice(-4);
}

function isoNow() {
  return new Date().toISOString();
}

function buildPrompt(session) {
  const callerLabel = session.caller || 'unknown caller';
  const ownerHint = session.isOwner
    ? "This caller matches Omar's owner number. You can treat them as Omar."
    : 'This caller is not authenticated as Omar. Treat them as a guest caller.';

  return sanitizeForTwilio(`
# You ARE Bridget
You are Bridget, Omar Ali's voice front door. You work with Omar's brain and with Beatrix behind the scenes.
You are concise, warm, and practical on the phone. You never pretend to be a generic AI assistant.

# Caller
Caller ID: ${callerLabel}
${ownerHint}

# Role
- Start the call with a short greeting.
- Search Omar's brain before answering questions about people, projects, context, or history.
- If the caller is unknown, ask what they need and take a clean message.
- If the caller shares something important, call log_voice_request immediately.
- Never read back sensitive data such as full phone numbers, email addresses, API keys, or raw tokens.

# Conversation Timing
- If the caller is still thinking, wait.
- If the caller finishes a complete thought and there is a short pause, respond.
- Do not interrupt stories or half-finished sentences.
- Never hang up first.

# Tool Use
- Use search_brain before answering factual questions about Omar's work or relationships.
- Use get_page only when you need the full page body for a specific slug.
- Use log_voice_request when the caller gives a task, reminder, commitment, or relationship signal worth saving immediately.

# Guardrails
- Keep answers spoken and natural.
- Do not say you are checking a database. Say you are checking Omar's brain.
- If you are unsure, say so plainly and offer to take a message.
  `.trim());
}

function buildTools() {
  return [
    {
      type: 'function',
      name: 'search_brain',
      description: "Search Omar's brain for relevant context before answering a question.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', description: 'What to search for.' },
          limit: {
            type: 'integer',
            description: 'Number of results to return, between 1 and 5.',
            minimum: 1,
            maximum: 5,
          },
        },
        required: ['query'],
      },
    },
    {
      type: 'function',
      name: 'get_page',
      description: "Fetch a full markdown page from Omar's brain by slug.",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          slug: { type: 'string', description: 'Exact page slug, for example people/garry-tan.' },
        },
        required: ['slug'],
      },
    },
    {
      type: 'function',
      name: 'log_voice_request',
      description: 'Store an important note, request, or commitment from the call immediately.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          note: { type: 'string', description: 'The important thing to remember.' },
          kind: {
            type: 'string',
            description: 'Short category such as reminder, idea, relationship, or task.',
          },
        },
        required: ['note'],
      },
    },
  ];
}

function buildSessionUpdate(session) {
  return {
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: buildPrompt(session),
      audio: {
        input: {
          format: 'g711_ulaw',
          noise_reduction: { type: 'near_field' },
          transcription: { model: 'gpt-4o-mini-transcribe' },
          turn_detection: {
            type: 'server_vad',
            create_response: true,
            interrupt_response: true,
            idle_timeout_ms: 6000,
          },
        },
        output: {
          format: 'g711_ulaw',
          voice: VOICE,
        },
      },
      tools: buildTools(),
      tool_choice: 'auto',
      max_output_tokens: 512,
    },
  };
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function twiml(response, body) {
  response.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' });
  response.end(body);
}

async function proxyHttp(request, response, targetUrl, body = null) {
  try {
    const upstream = await fetch(targetUrl, {
      method: request.method,
      headers: {
        'authorization': request.headers.authorization || '',
        'content-type': request.headers['content-type'] || 'application/json',
        'accept': request.headers.accept || 'application/json',
      },
      body,
    });
    const text = await upstream.text();
    response.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
    });
    response.end(text);
  } catch (error) {
    json(response, 502, {
      ok: false,
      error: 'upstream_unavailable',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function requestUrl(request) {
  const host = request.headers.host || 'localhost';
  const base = PUBLIC_BASE_URL || `http://${host}`;
  return new URL(request.url, base);
}

function verifyTwilioRequest(request, body) {
  if (SKIP_TWILIO_SIGNATURE) return true;
  if (!TWILIO_AUTH_TOKEN) return false;
  const signature = request.headers['x-twilio-signature'];
  if (!signature) return false;
  const url = requestUrl(request).toString();
  const params = Object.fromEntries(new URLSearchParams(body));
  return twilio.validateRequest(TWILIO_AUTH_TOKEN, String(signature), url, params);
}

function createCallSession(request) {
  const session = {
    id: crypto.randomUUID(),
    createdAt: new Date(),
    caller: 'unknown caller',
    callSid: null,
    streamSid: null,
    openAiReady: false,
    greetingSent: false,
    finalized: false,
    isOwner: false,
    userTurns: [],
    assistantTurns: [],
    notes: [],
    assistantPartial: '',
    pendingAudio: [],
    wsRequestHeaders: request.headers,
    startPayload: null,
    openAiSocket: null,
    twilioSocket: null,
  };
  callSessions.set(session.id, session);
  return session;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    });
    const stdout = [];
    const stderr = [];
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGTERM');
      reject(new Error(`Command timed out: ${command} ${args.join(' ')}`));
    }, options.timeoutMs || TOOL_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8');
      if (code === 0) {
        resolve({ stdout: out, stderr: err });
        return;
      }
      reject(new Error(err || out || `Command exited with code ${code}`));
    });

    if (options.stdin) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

async function runGbrain(args, { stdin, timeoutMs } = {}) {
  // On the cloud container gbrain is installed globally on PATH (via
  // `bun install -g github:garrytan/gbrain` in the Dockerfile). Invoke
  // it directly rather than via bun+ts source path.
  return runCommand(process.env.GBRAIN_BIN || 'gbrain', args, {
    stdin,
    timeoutMs,
  });
}

async function executeTool(name, rawArguments, session) {
  let args = {};
  try {
    args = rawArguments ? JSON.parse(rawArguments) : {};
  } catch {
    args = {};
  }

  if (name === 'search_brain') {
    const query = String(args.query || '').trim();
    if (!query) {
      return { ok: false, error: 'Missing query.' };
    }
    const limit = Math.max(1, Math.min(5, Number(args.limit || 3)));
    const { stdout } = await runGbrain(['query', query, '--limit', String(limit)]);
    return { ok: true, query, results: stdout.trim() };
  }

  if (name === 'get_page') {
    const slug = String(args.slug || '').trim();
    if (!slug) {
      return { ok: false, error: 'Missing slug.' };
    }
    const { stdout } = await runGbrain(['get', slug]);
    return { ok: true, slug, content: scrubPii(stdout.trim()) };
  }

  if (name === 'log_voice_request') {
    const note = String(args.note || '').trim();
    const kind = String(args.kind || 'note').trim() || 'note';
    if (!note) {
      return { ok: false, error: 'Missing note.' };
    }
    const entry = {
      ts: isoNow(),
      kind,
      note,
      caller: session.caller,
      call_sid: session.callSid,
    };
    session.notes.push(entry);
    await appendFile(join(LOG_DIR, 'voice-agent.requests.jsonl'), `${JSON.stringify(entry)}\n`);
    return { ok: true, stored: true, kind };
  }

  return { ok: false, error: `Unknown tool: ${name}` };
}

async function summarizeTranscript(session, transcriptText) {
  const payload = {
    model: OPENAI_SUMMARY_MODEL,
    messages: [
      {
        role: 'system',
        content: 'You summarize Omar Ali phone calls. Return strict JSON with keys: title, summary, action_items, people, companies. action_items, people, companies must be arrays of short strings.',
      },
      {
        role: 'user',
        content: `Caller: ${session.caller}\nCall transcript:\n${transcriptText}`,
      },
    ],
    temperature: 0.2,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'voice_call_summary',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            action_items: {
              type: 'array',
              items: { type: 'string' },
            },
            people: {
              type: 'array',
              items: { type: 'string' },
            },
            companies: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['title', 'summary', 'action_items', 'people', 'companies'],
        },
      },
    },
  };

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Summary request failed with ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Missing summary content.');
    }
    return JSON.parse(content);
  } catch (error) {
    return {
      title: `Voice Call with ${session.caller}`,
      summary: `Voice call captured on ${session.createdAt.toISOString().slice(0, 10)}. A model summary was unavailable, so this page contains the raw transcript and any live notes.`,
      action_items: session.notes.map((entry) => entry.note),
      people: [],
      companies: [],
      summary_error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildTranscriptText(session) {
  const lines = [];
  const turnCount = Math.max(session.userTurns.length, session.assistantTurns.length);
  for (let index = 0; index < turnCount; index += 1) {
    const userTurn = session.userTurns[index];
    if (userTurn) lines.push(`Caller: ${userTurn}`);
    const assistantTurn = session.assistantTurns[index];
    if (assistantTurn) lines.push(`Bridget: ${assistantTurn}`);
  }
  return lines.join('\n\n').trim();
}

async function importBrainWorkingTree() {
  // No-op on cloud. The legacy Mac path imported a local working tree;
  // cloud writes go directly to Supabase via `gbrain put` in writeCallPage.
  // Kept as a function so legacy callers don't crash.
  return;
}

async function writeCallPage(session) {
  // Cloud-adapted writeCallPage. The Mac version wrote to disk and re-imported
  // via gbrain. On cloud we pipe the same content straight to `gbrain put`
  // so brain ingestion happens via Supabase without needing a local vault.
  //
  // Slug collision: `gbrain get <slug>` returns 0 if the page exists. We try
  // suffix-2, -3, ... until we hit a free one (cap at 99 just in case).
  const transcriptText = buildTranscriptText(session);
  const summary = await summarizeTranscript(session, transcriptText || 'No transcript captured.');
  const datePart = session.createdAt.toISOString().slice(0, 10);
  const year = datePart.slice(0, 4);
  const baseSlug = `meetings/${year}/${datePart}-call-${slugPartFromCaller(session.caller)}`;
  let slug = baseSlug;
  let suffix = 2;
  while (suffix <= 99) {
    let exists = false;
    try {
      await runGbrain(['get', slug], { timeoutMs: 5000 });
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) break;
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  const noteLines = session.notes.length
    ? session.notes.map((entry) => `- ${entry.kind}: ${entry.note}`).join('\n')
    : '- None captured during the call.';
  const actionLines = summary.action_items?.length
    ? summary.action_items.map((item) => `- ${item}`).join('\n')
    : '- None recorded.';
  const peopleLine = summary.people?.length ? summary.people.join(', ') : 'None';
  const companiesLine = summary.companies?.length ? summary.companies.join(', ') : 'None';
  const metadata = [
    '---',
    'type: meeting',
    `title: ${JSON.stringify(summary.title || `Voice Call with ${session.caller}`)}`,
    'tags:',
    '  - voice',
    '  - twilio',
    '  - call',
    `caller: ${JSON.stringify(session.caller)}`,
    `call_sid: ${JSON.stringify(session.callSid || '')}`,
    `agent: ${JSON.stringify('Bridget')}`,
    `started_at: ${JSON.stringify(session.createdAt.toISOString())}`,
    `ended_at: ${JSON.stringify(new Date().toISOString())}`,
    '---',
    '',
  ].join('\n');

  const compiledTruth = [
    '## Summary',
    '',
    summary.summary || 'No summary available.',
    '',
    '## Action Items',
    '',
    actionLines,
    '',
    '## Entities',
    '',
    `People: ${peopleLine}`,
    '',
    `Companies: ${companiesLine}`,
    '',
    '## Live Notes',
    '',
    noteLines,
    '',
    '---',
    '',
    '## Transcript',
    '',
    transcriptText || 'No transcript captured.',
    '',
  ].join('\n');

  // Write directly to brain via gbrain put (stdin), then embed.
  await runGbrain(['put', slug], { stdin: metadata + compiledTruth, timeoutMs: 30000 });
  await runGbrain(['embed', slug], { timeoutMs: 30000 }).catch(() => { /* embed failure is non-fatal */ });
  return `gbrain://${slug}`;
}

function sendInitialGreeting(openAiSocket, session) {
  if (session.greetingSent || openAiSocket.readyState !== WebSocket.OPEN) {
    return;
  }
  session.greetingSent = true;
  openAiSocket.send(JSON.stringify({
    type: 'response.create',
    response: {
      conversation: 'auto',
      metadata: { purpose: 'initial_greeting' },
    },
  }));
}

async function finalizeSession(session, reason) {
  if (session.finalized) return;
  session.finalized = true;

  try {
    const pagePath = await writeCallPage(session);
    await appendFile(join(LOG_DIR, 'voice-agent.calls.jsonl'), `${JSON.stringify({
      ts: isoNow(),
      reason,
      caller: session.caller,
      call_sid: session.callSid,
      page_path: pagePath,
      note_count: session.notes.length,
    })}\n`);
  } catch (error) {
    await appendFile(join(LOG_DIR, 'voice-agent.errors.log'), `[${isoNow()}] finalize failure: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  } finally {
    callSessions.delete(session.id);
  }
}

function attachOpenAiHandlers(session) {
  const openAiSocket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`, {
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
    },
  });

  session.openAiSocket = openAiSocket;

  openAiSocket.on('open', () => {
    session.openAiReady = true;
    openAiSocket.send(JSON.stringify(buildSessionUpdate(session)));
  });

  openAiSocket.on('message', async (buffer) => {
    let event;
    try {
      event = JSON.parse(buffer.toString());
    } catch {
      return;
    }

    if (event.type === 'session.created' || event.type === 'session.updated') {
      for (const payload of session.pendingAudio.splice(0)) {
        openAiSocket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
      }
      sendInitialGreeting(openAiSocket, session);
      return;
    }

    if (event.type === 'response.output_audio.delta' && session.twilioSocket?.readyState === WebSocket.OPEN && session.streamSid) {
      session.twilioSocket.send(JSON.stringify({
        event: 'media',
        streamSid: session.streamSid,
        media: { payload: event.delta },
      }));
      return;
    }

    if (event.type === 'response.output_audio_transcript.delta') {
      session.assistantPartial += event.delta || '';
      return;
    }

    if (event.type === 'response.output_audio_transcript.done') {
      const transcript = (event.transcript || session.assistantPartial || '').trim();
      if (transcript) session.assistantTurns.push(scrubPii(transcript));
      session.assistantPartial = '';
      return;
    }

    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const transcript = (event.transcript || '').trim();
      if (transcript) session.userTurns.push(scrubPii(transcript));
      return;
    }

    if (event.type === 'response.function_call_arguments.done') {
      try {
        const result = await executeTool(event.name, event.arguments, session);
        openAiSocket.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: event.call_id,
            output: JSON.stringify(result),
          },
        }));
        openAiSocket.send(JSON.stringify({
          type: 'response.create',
          response: {
            conversation: 'auto',
            metadata: { purpose: 'tool_follow_up' },
          },
        }));
      } catch (error) {
        const failure = {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
        openAiSocket.send(JSON.stringify({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: event.call_id,
            output: JSON.stringify(failure),
          },
        }));
        openAiSocket.send(JSON.stringify({
          type: 'response.create',
          response: {
            conversation: 'auto',
            metadata: { purpose: 'tool_error_follow_up' },
          },
        }));
      }
      return;
    }

    if (event.type === 'error') {
      appendFile(join(LOG_DIR, 'voice-agent.errors.log'), `[${isoNow()}] openai error: ${JSON.stringify(event)}\n`).catch(() => {});
    }
  });

  openAiSocket.on('close', () => {
    if (session.twilioSocket?.readyState === WebSocket.OPEN) {
      session.twilioSocket.close();
    }
    finalizeSession(session, 'openai-close').catch(() => {});
  });

  openAiSocket.on('error', (error) => {
    appendFile(join(LOG_DIR, 'voice-agent.errors.log'), `[${isoNow()}] openai websocket error: ${error instanceof Error ? error.stack || error.message : String(error)}\n`).catch(() => {});
  });
}

const server = http.createServer(async (request, response) => {
  const url = requestUrl(request);

  if (request.method === 'GET' && url.pathname === '/health') {
    return json(response, 200, {
      ok: true,
      model: OPENAI_REALTIME_MODEL,
      public_url: PUBLIC_BASE_URL || null,
      active_calls: callSessions.size,
    });
  }

  if (request.method === 'GET' && url.pathname === '/mcp/health') {
    return proxyHttp(request, response, `${REMOTE_MCP_INTERNAL_URL}/health`);
  }

  if (request.method === 'POST' && url.pathname === '/mcp') {
    const body = await readBody(request);
    return proxyHttp(request, response, `${REMOTE_MCP_INTERNAL_URL}/mcp`, body);
  }

  if (request.method === 'POST' && url.pathname === '/voice') {
    const body = await readBody(request);
    if (!verifyTwilioRequest(request, body)) {
      return json(response, 403, { ok: false, error: 'invalid_twilio_signature' });
    }

    const params = new URLSearchParams(body);
    const caller = normalizePhone(params.get('From') || '') || 'unknown caller';
    const callSid = params.get('CallSid') || '';
    const host = request.headers.host || (PUBLIC_BASE_URL ? new URL(PUBLIC_BASE_URL).host : '');
    if (!host) {
      return json(response, 500, { ok: false, error: 'missing_public_host' });
    }
    const websocketUrl = `wss://${host}/ws`;
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Response>',
      '  <Connect>',
      `    <Stream url="${websocketUrl}">`,
      `      <Parameter name="caller" value="${caller}" />`,
      `      <Parameter name="callSid" value="${callSid}" />`,
      '    </Stream>',
      '  </Connect>',
      '</Response>',
    ].join('\n');
    return twiml(response, xml);
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('not found');
});

const webSocketServer = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const url = requestUrl(request);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  webSocketServer.handleUpgrade(request, socket, head, (websocket) => {
    webSocketServer.emit('connection', websocket, request);
  });
});

webSocketServer.on('connection', (twilioSocket, request) => {
  const session = createCallSession(request);
  session.twilioSocket = twilioSocket;

  twilioSocket.on('message', (buffer) => {
    let event;
    try {
      event = JSON.parse(buffer.toString());
    } catch {
      return;
    }

    if (event.event === 'start') {
      session.startPayload = event.start;
      session.streamSid = event.start?.streamSid || null;
      session.callSid = event.start?.callSid || event.start?.customParameters?.callSid || null;
      session.caller = normalizePhone(event.start?.customParameters?.caller || '') || session.caller;
      session.isOwner = OWNER_PHONE && normalizePhone(session.caller) === OWNER_PHONE;
      attachOpenAiHandlers(session);
      return;
    }

    if (event.event === 'media') {
      const payload = event.media?.payload;
      if (!payload) return;
      if (session.openAiReady && session.openAiSocket?.readyState === WebSocket.OPEN) {
        session.openAiSocket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
      } else {
        session.pendingAudio.push(payload);
      }
      return;
    }

    if (event.event === 'stop') {
      if (session.openAiSocket?.readyState === WebSocket.OPEN) {
        session.openAiSocket.close();
      } else {
        finalizeSession(session, 'twilio-stop').catch(() => {});
      }
    }
  });

  twilioSocket.on('close', () => {
    if (session.openAiSocket?.readyState === WebSocket.OPEN) {
      session.openAiSocket.close();
      return;
    }
    finalizeSession(session, 'twilio-close').catch(() => {});
  });

  twilioSocket.on('error', (error) => {
    appendFile(join(LOG_DIR, 'voice-agent.errors.log'), `[${isoNow()}] twilio websocket error: ${error instanceof Error ? error.stack || error.message : String(error)}\n`).catch(() => {});
  });
});

server.listen(PORT, HOST, () => {
  appendFile(join(LOG_DIR, 'voice-agent.log'), `[${isoNow()}] voice agent listening on ${HOST}:${PORT}\n`).catch(() => {});
});
