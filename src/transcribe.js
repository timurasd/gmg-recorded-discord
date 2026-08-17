import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import FormData from 'form-data';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ensureDir } from './utils.js';

const exec = promisify(execFile);

/**
 * Конвертировать PCM (signed 16-bit LE, 48kHz, stereo) в WAV через ffmpeg.
 */
export async function pcmToWav(pcmFile, wavFile) {
  await exec('ffmpeg', [
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    '-i', pcmFile,
    '-ar', '16000',
    '-ac', '1',
    wavFile,
    '-y',
  ]);
}

/**
 * Отправить WAV-файл в локальный Whisper API и получить текст.
 */
export async function transcribeAudio(wavFile, language = 'ru') {
  const form = new FormData();
  form.append('file', await fs.readFile(wavFile), { filename: path.basename(wavFile) });
  form.append('model', process.env.WHISPER_MODEL || 'large-v3');
  form.append('language', language);
  form.append('response_format', 'json');

  const url = process.env.WHISPER_URL || 'http://localhost:8000/v1/audio/transcriptions';
  const { data } = await axios.post(url, form, {
    headers: form.getHeaders(),
    timeout: 600000,
  });

  return data.text || data.transcription || '';
}

/**
 * Транскрибировать все файлы участников и собрать единую расшифровку
 * с временными метками и идентификаторами спикеров.
 */
export async function transcribeSession(userFiles, sessionDir) {
  const transcriptsDir = path.join(sessionDir, 'transcripts');
  await ensureDir(transcriptsDir);

  const segments = [];

  for (const { userId, pcmFile, startOffset } of userFiles) {
    const wavFile = path.join(transcriptsDir, `${userId}.wav`);
    await pcmToWav(pcmFile, wavFile);
    const text = await transcribeAudio(wavFile, process.env.WHISPER_LANGUAGE || 'ru');

    if (text.trim()) {
      segments.push({
        userId,
        offsetMs: startOffset,
        text: text.trim(),
      });
    }
  }

  // Сортировать по времени старта записи участника
  segments.sort((a, b) => a.offsetMs - b.offsetMs);

  return segments.map((seg) => `[<@${seg.userId}>] ${seg.text}`).join('\n');
}
