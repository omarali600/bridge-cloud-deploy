/**
 * Photo surface adapter.
 *
 * Same shape as voice-memo: cloud can't see local disk, so a local Mac
 * daemon watches Screenshots/ and Downloads/ and posts here whenever
 * a new image lands.
 *
 * The local daemon does:
 *   • fs.watch on ~/Library/Mobile Documents/com~apple~CloudDocs/Screenshots/
 *     and ~/Downloads/ for image files
 *   • Run OCR (tesseract or OpenAI vision) and a vision-summary call
 *   • POST { filename, takenAt, sourceDir, ocr, visionSummary } here
 *
 * We classify it through the same pipeline. The classifier's rule-based
 * pass catches receipts and business cards.
 */

import { ingest } from '../pipeline.mjs';

export function normalize(payload) {
  return {
    surface: 'photo',
    receivedAt: payload.takenAt ?? new Date().toISOString(),
    from: {
      identifier: 'omar',
      display: 'Omar (photo)',
      kind: 'self',
    },
    content: {
      subject: payload.filename ?? 'photo',
      ocr: payload.ocr ?? '',
      vision: payload.visionSummary ?? '',
      rawSurfaceMetadata: {
        filename: payload.filename,
        source_dir: payload.sourceDir,
        sha256: payload.fileHashSha256,
        dimensions: payload.dimensions,
      },
    },
    hints: {},
  };
}

export async function handle(payload) {
  const item = normalize(payload);
  return ingest(item);
}
