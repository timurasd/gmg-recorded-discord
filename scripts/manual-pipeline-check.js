// Manual end-to-end check on the server, without Discord/Telegram:
//   node scripts/manual-pipeline-check.js <session_dir_with_chunks>
// Runs WAV conversion + Whisper + timeline, the Claude summary, and the mix.
// Not part of `npm test` (needs ffmpeg, faster-whisper and an API key).
import 'dotenv/config';
import path from 'path';
import { readdirSync, existsSync } from 'fs';
import fs from 'fs/promises';
import { listChunkFiles, concatenateChunkFilesWithGaps, markersPath, wavMarkersPath } from '../src/recorder/chunk-writer.js';
import { transcribeSession } from '../src/transcribe.js';
import { summarizeTranscript } from '../src/summarize.js';
import { parseMarkers, formatTranscript, markersWithGaps, UTTERANCE_GAP_BYTES } from '../src/timeline.js';
import { buildMixedAudio } from '../src/mix.js';

const dir = path.resolve(process.argv[2]);
const users = [];
for (const userId of readdirSync(path.join(dir, 'chunks'))) {
  const pcmFile = path.join(dir, `${userId}.pcm`);
  const mf = markersPath(dir, userId);
  const markers = existsSync(mf) ? parseMarkers(await fs.readFile(mf, 'utf-8')) : [];
  await concatenateChunkFilesWithGaps(listChunkFiles(path.join(dir, 'chunks', userId)), pcmFile, markers, UTTERANCE_GAP_BYTES);
  const fileMarkers = markersWithGaps(markers);
  await fs.writeFile(wavMarkersPath(dir, userId), fileMarkers.map((m) => JSON.stringify(m)).join('\n') + '\n');
  users.push({ userId, name: `User_${userId.slice(-4)}`, pcmFile, markers: fileMarkers });
}

let t = Date.now();
const { lines } = await transcribeSession(users, dir, (p, n) => console.log(`progress ${p}% ${n}`));
console.log(`\nWhisper: ${((Date.now() - t) / 1000).toFixed(1)} s\n${formatTranscript(lines)}\n`);

t = Date.now();
const res = await summarizeTranscript(formatTranscript(lines), { participants: users.map((u) => u.name), durationText: 'тест' });
console.log(`Summary (${((Date.now() - t) / 1000).toFixed(1)} s):`, res.summary ? `\n${res.summary}` : `FAILED: ${res.error}`);

const session = JSON.parse(await fs.readFile(path.join(dir, 'session.json'), 'utf-8'));
const files = await buildMixedAudio({ dir, startTime: session.startTime, endTime: session.endTime || session.startTime + 120000 });
for (const f of files) console.log('mix:', f, (await fs.stat(f)).size, 'bytes');
