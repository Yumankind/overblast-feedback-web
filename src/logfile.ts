/**
 * `logFile` (contract §3.5): everything the buffer holds, one JSON entry per line, oldest first,
 * gzip-compressed with `CompressionStream` (`identity` where a browser has none), at most 4 MB as
 * sent. When it would be larger, the oldest lines are cut until it fits and the file's first line
 * says what was cut.
 */

import { groupDigits, SELF_SRC } from './logbuffer.ts';
import { cleanLog } from './payload.ts';
import { utf8Length } from './redact.ts';
import type { FeedbackBody, LogEntry, LogFileBody } from './types.ts';

/**
 * The file's ceiling, measured on the base64 text as sent, and in decimal megabytes: whichever way
 * the door measures "4 MB", this is under it.
 */
export const LOG_FILE_MAX = 4_000_000;
/** The door's body ceiling (§3), in decimal megabytes for the same reason. */
export const MAX_BODY_BYTES = 8_000_000;

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** gzip with the browser's own `CompressionStream`; null where it is missing or fails. */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream !== 'function' || typeof Blob === 'undefined' || typeof Response === 'undefined') return null;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
/** `13:40`, in the device's own time zone (the report's `context.timeZone` says which). */
function clock(t: number): string {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface LogFileOptions {
  /** The most base64 the file may take. Default 4 MB. */
  maxBase64?: number;
  /** Default true; false sends `identity` (the tests, and browsers without CompressionStream). */
  compress?: boolean;
}

async function encode(lines: string[], compress: boolean): Promise<{ base64: string; encoding: 'gzip' | 'identity' }> {
  const raw = new TextEncoder().encode(lines.join('\n') + '\n');
  const packed = compress ? await gzip(raw) : null;
  return packed ? { base64: bytesToBase64(packed), encoding: 'gzip' } : { base64: bytesToBase64(raw), encoding: 'identity' };
}

/** The file, cut from the oldest end until it fits; null when there is nothing, or nothing fits. */
export async function buildLogFile(entries: LogEntry[], opts: LogFileOptions = {}): Promise<LogFileBody | null> {
  const max = Math.min(opts.maxBase64 ?? LOG_FILE_MAX, LOG_FILE_MAX);
  const clean = entries.filter((e) => e && typeof e.msg === 'string' && typeof e.t === 'number').map(cleanLog);
  if (!clean.length || max < 256) return null;
  const lines = clean.map((e) => JSON.stringify(e));
  const compress = opts.compress !== false;

  let keep = clean.length;
  for (let attempt = 0; attempt < 8 && keep > 0; attempt++) {
    const cut = clean.length - keep;
    const body = lines.slice(cut);
    let first = clean[cut]!;
    if (cut > 0) {
      const marker: LogEntry = {
        t: clean[cut - 1]!.t,
        level: 'warn',
        src: SELF_SRC,
        msg: `older lines cut to fit: ${groupDigits(cut)} lines from ${clock(clean[0]!.t)} to ${clock(clean[cut - 1]!.t)}`,
      };
      body.unshift(JSON.stringify(marker));
      first = marker;
    }
    const { base64, encoding } = await encode(body, compress);
    if (base64.length <= max) {
      return { contentType: 'application/x-ndjson', encoding, base64, lines: body.length, from: first.t, to: clean[clean.length - 1]!.t };
    }
    // Keep the share that should fit, with a margin, and try again.
    keep = Math.floor(keep * (max / base64.length) * 0.92);
  }
  return null;
}

/**
 * Add the log file to a built body, unless its excerpt already holds every line, in whatever room
 * the rest leaves under the 8 MB ceiling (§3.5:
 * the log file gives way first, so a screenshot, already held to 5 MB, always fits). Returns the
 * body; without room, or without lines, it is left as it was.
 */
export async function attachLogFile(body: FeedbackBody, lines: LogEntry[], opts: LogFileOptions & { maxBody?: number } = {}): Promise<FeedbackBody> {
  // When the excerpt already holds every line, the file would only repeat it (§3.5).
  if (!lines.length || (body.logs?.length ?? 0) >= lines.length) return body;
  // The JSON around the file (`,"logFile":{…}` and its other fields) is well under 1 KB.
  const room = (opts.maxBody ?? MAX_BODY_BYTES) - utf8Length(JSON.stringify(body)) - 1024;
  if (room < 256) return body;
  try {
    const file = await buildLogFile(lines, { ...opts, maxBase64: Math.min(opts.maxBase64 ?? LOG_FILE_MAX, room) });
    if (file) body.logFile = file;
  } catch {
    /* the excerpt still goes */
  }
  return body;
}
