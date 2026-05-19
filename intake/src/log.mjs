// Tiny stderr logger with ISO timestamps. Render captures stderr.
// Same shape as the relay's log.mjs so the two services log compatibly.
export function log(msg, extra) {
  const ts = new Date().toISOString();
  const line = extra
    ? `[${ts}] ${msg} ${JSON.stringify(extra)}`
    : `[${ts}] ${msg}`;
  process.stderr.write(line + '\n');
}
