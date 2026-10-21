import fs from 'fs/promises';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { ensureDir } from './utils.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { mergeSegments, pieceRanges, shiftSegments, PCM_BYTES_PER_MS } from './timeline.js';

const exec = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

/**
 * Конвертировать PCM (signed 16-bit LE, 48kHz, stereo) в WAV 16 kHz mono через ffmpeg.
 * Возвращает false, если PCM пустой.
 */
export async function pcmToWav(pcmFile, wavFile) {
  const stats = await fs.stat(pcmFile);
  console.log(`📂 PCM file: ${pcmFile}, size: ${(stats.size / 1024).toFixed(2)} KB`);
  if (stats.size === 0) {
    console.warn(`⚠️  PCM file is empty, skipping conversion`);
    return false;
  }

  await exec('ffmpeg', ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', pcmFile, '-ar', '16000', '-ac', '1', wavFile, '-y']);
  const wavStats = await fs.stat(wavFile);
  console.log(`✅ WAV created: ${(wavStats.size / 1024).toFixed(2)} KB`);
  return wavStats.size > 0;
}

/**
 * Run whisper_transcribe.py once for all files (the model loads once).
 * `nice` keeps it from starving the other services on this 2-CPU droplet.
 * onFile(index) fires as each file starts, for the progress message.
 */
function runWhisper(wavFiles, language, modelSize, onFile) {
  const pythonCmd = process.env.PYTHON_CMD || 'python3';
  const script = path.join(projectRoot, 'whisper_transcribe.py');
  return new Promise((resolve, reject) => {
    const child = spawn('nice', ['-n', '10', pythonCmd, script, language, modelSize, ...wavFiles]);
    let stdout = '';
    let stderrTail = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      for (const line of text.split('\n')) {
        const m = line.match(/^Transcribing (.+)\.\.\.$/);
        if (m) {
          const i = wavFiles.indexOf(m[1]);
          if (i >= 0 && onFile) onFile(i);
        }
        if (line.trim()) console.log(`   [whisper] ${line.trim()}`);
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`whisper exited with ${code}: ${stderrTail.slice(-500)}`));
      try {
        resolve(JSON.parse(stdout).files || {});
      } catch (err) {
        reject(new Error(`whisper output is not JSON: ${err.message}`));
      }
    });
  });
}

/**
 * Расшифровать созвон: WAV для каждого участника -> Whisper -> реплики всех
 * участников в порядке времени созвона.
 *
 * users: [{ userId, name, pcmFile, markers }]
 * Returns { lines, wavFiles: { userId: wavPath } }
 */
export async function transcribeSession(users, sessionDir, onProgress = null) {
  const transcriptsDir = path.join(sessionDir, 'transcripts');
  await ensureDir(transcriptsDir);

  const ready = [];
  for (const user of users) {
    const wavFile = path.join(transcriptsDir, `${user.userId}.wav`);
    try {
      if (await pcmToWav(user.pcmFile, wavFile)) ready.push({ ...user, wavFile });
    } catch (error) {
      console.error(`❌ WAV conversion failed for ${user.name}:`, error.message);
    }
  }
  if (ready.length === 0) throw new Error('Нет аудио для расшифровки.');

  // Long tracks go to Whisper in pieces of up to 10 min, cut in the pauses
  // between utterances: its memory grows with file length.
  const pieces = [];
  for (const user of ready) {
    const totalSec = (await fs.stat(user.pcmFile)).size / (PCM_BYTES_PER_MS * 1000);
    const ranges = pieceRanges(user.markers, totalSec, Number(process.env.WHISPER_PIECE_SEC) || 600);
    if (ranges.length === 1) {
      pieces.push({ user, file: user.wavFile, offsetSec: 0 });
      continue;
    }
    for (const [i, { start, end }] of ranges.entries()) {
      const file = path.join(transcriptsDir, `${user.userId}.part${i}.wav`);
      await exec('ffmpeg', ['-loglevel', 'error', '-y', '-i', user.wavFile, '-ss', String(start), '-to', String(end), '-c:a', 'pcm_s16le', file]);
      pieces.push({ user, file, offsetSec: start, temp: true });
    }
    console.log(`✂️ ${user.name}: ${Math.round(totalSec / 60)} min of audio in ${ranges.length} pieces`);
  }

  const language = process.env.WHISPER_LANGUAGE || 'ru';
  const modelSize = process.env.WHISPER_MODEL || 'small';
  console.log(`📝 Transcribing ${ready.length} user(s), ${pieces.length} piece(s), with Whisper ${modelSize}...`);

  let results;
  try {
    results = await runWhisper(pieces.map((p) => p.file), language, modelSize, async (i) => {
      if (onProgress) await onProgress(Math.round((i / pieces.length) * 90), pieces[i].user.name);
    });
  } finally {
    for (const p of pieces) if (p.temp) await fs.rm(p.file, { force: true });
  }

  const lines = mergeSegments(ready.map((u) => ({
    name: u.name,
    markers: u.markers,
    segments: pieces
      .filter((p) => p.user === u)
      .flatMap((p) => shiftSegments(results[p.file]?.segments || [], p.offsetSec)),
  })));
  console.log(`📊 Transcript: ${lines.length} line(s)`);
  if (lines.length === 0) {
    throw new Error('Whisper ничего не распознал. Возможно, аудио было слишком коротким или тихим.');
  }

  return { lines, wavFiles: Object.fromEntries(ready.map((u) => [u.userId, u.wavFile])) };
}
