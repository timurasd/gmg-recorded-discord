/**
 * Mixed audio of a whole meeting, for !audio -- one track with everyone in it,
 * at the moments they spoke, to hand to other AI tools.
 *
 * Built on request from what the pipeline keeps: each user's 16 kHz mono WAV
 * and their utterance markers. 32 kbps mono MP3 is ~14 MB per hour; anything
 * longer than a Telegram upload allows is cut into parts.
 */

import fs from 'fs/promises';
import { existsSync, readdirSync } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { parseMarkers, mixPlacements } from './timeline.js';
import { wavMarkersPath } from './recorder/chunk-writer.js';

const exec = promisify(execFile);
const SAMPLE_RATE = 16000;
const BITRATE_KBPS = 32;
const MAX_PART_BYTES = 45 * 1024 * 1024; // Telegram bots upload up to 50 MB
const MAX_PART_SECONDS = Math.floor(MAX_PART_BYTES / (BITRATE_KBPS * 1000 / 8));

/** The samples of a 16-bit PCM WAV (finds the "data" chunk; ffmpeg adds a LIST chunk). */
export function wavSamples(buf) {
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size));
      const aligned = new Uint8Array(data.length - (data.length % 2));
      aligned.set(data.subarray(0, aligned.length));
      return new Int16Array(aligned.buffer);
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('WAV has no data chunk');
}

function stampOf(startTime) {
  // Moscow wall clock for the file name: call_2026-10-19_14-03
  return new Date(startTime + 3 * 3600_000).toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
}

/**
 * Returns the mp3 file(s) of the session, building them on first request.
 * session: { dir, startTime, endTime }
 */
export async function buildMixedAudio(session) {
  const stamp = stampOf(session.startTime);
  const existing = readdirSync(session.dir).filter((f) => f.startsWith(`call_${stamp}`) && f.endsWith('.mp3')).sort();
  if (existing.length > 0) return existing.map((f) => path.join(session.dir, f));

  const transcriptsDir = path.join(session.dir, 'transcripts');
  const wavs = existsSync(transcriptsDir) ? readdirSync(transcriptsDir).filter((f) => f.endsWith('.wav')) : [];
  if (wavs.length === 0) throw new Error('у этой записи не осталось звука');

  const durationMs = Math.max(1000, session.endTime - session.startTime);
  const totalSamples = Math.ceil((durationMs / 1000) * SAMPLE_RATE) + SAMPLE_RATE;
  const mix = new Int16Array(totalSamples);

  for (const wav of wavs) {
    const userId = path.basename(wav, '.wav');
    const samples = wavSamples(await fs.readFile(path.join(transcriptsDir, wav)));
    const markersFile = wavMarkersPath(session.dir, userId);
    const markers = existsSync(markersFile) ? parseMarkers(await fs.readFile(markersFile, 'utf-8')) : [];
    for (const { srcStart, srcEnd, dstStart } of mixPlacements(markers, samples.length)) {
      for (let i = srcStart; i < srcEnd && i < samples.length; i++) {
        const d = dstStart + (i - srcStart);
        if (d >= totalSamples) break;
        const v = mix[d] + samples[i];
        mix[d] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
      }
    }
  }

  const rawPath = path.join(session.dir, 'mix.raw');
  await fs.writeFile(rawPath, Buffer.from(mix.buffer));
  try {
    const input = ['-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1', '-i', rawPath, '-c:a', 'libmp3lame', '-b:a', `${BITRATE_KBPS}k`];
    if (durationMs / 1000 <= MAX_PART_SECONDS) {
      await exec('nice', ['-n', '10', 'ffmpeg', '-y', ...input, path.join(session.dir, `call_${stamp}.mp3`)]);
    } else {
      await exec('nice', ['-n', '10', 'ffmpeg', '-y', ...input, '-f', 'segment', '-segment_time', String(MAX_PART_SECONDS),
        path.join(session.dir, `call_${stamp}_part%d.mp3`)]);
    }
  } finally {
    await fs.rm(rawPath, { force: true });
  }

  return readdirSync(session.dir)
    .filter((f) => f.startsWith(`call_${stamp}`) && f.endsWith('.mp3'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((f) => path.join(session.dir, f));
}
