/**
 * Voice memo surface adapter.
 *
 * The cloud daemon can't see Omar's Apple Voice Memos folder. So this adapter
 * exposes an /ingest/voice-memo HTTP endpoint that a local Mac daemon
 * (local-watchers/voicememo.mjs) posts to whenever it sees a new file.
 *
 * The local daemon does the work of:
 *   • fs.watch on ~/Library/Application Support/com.apple.voicememos/Recordings/
 *   • Whisper transcription via OpenAI
 *   • POST { filename, durationSec, recordedAt, transcript } to /ingest/voice-memo
 *
 * Here we just normalize the payload and hand it to the pipeline.
 */

import { ingest } from '../pipeline.mjs';

/**
 * Local-watcher posts:
 *   { filename, durationSec, recordedAt: ISO, transcript: string, fileHashSha256 }
 */
export function normalize(payload) {
  return {
    surface: 'voice-memo',
    receivedAt: payload.recordedAt ?? new Date().toISOString(),
    from: {
      identifier: 'omar',
      display: 'Omar (voice memo)',
      kind: 'self',
    },
    content: {
      subject: payload.filename ?? 'voice memo',
      transcript: payload.transcript ?? '',
      rawSurfaceMetadata: {
        filename: payload.filename,
        duration_sec: payload.durationSec,
        sha256: payload.fileHashSha256,
      },
    },
    hints: {},
  };
}

export async function handle(payload) {
  const item = normalize(payload);
  return ingest(item);
}
