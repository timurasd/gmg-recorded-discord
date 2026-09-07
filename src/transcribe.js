import fs from 'fs/promises';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ensureDir } from './utils.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const exec = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

/**
 * Конвертировать PCM (signed 16-bit LE, 48kHz, stereo) в WAV через ffmpeg.
 */
export async function pcmToWav(pcmFile, wavFile) {
  // Проверяем размер PCM файла
  const stats = await fs.stat(pcmFile);
  console.log(`📂 PCM file: ${pcmFile}, size: ${(stats.size / 1024).toFixed(2)} KB`);
  
  if (stats.size === 0) {
    console.warn(`⚠️  PCM file is empty, skipping conversion`);
    return;
  }

  console.log(`🔄 Converting ${pcmFile} to WAV...`);
  
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

  // Проверяем что WAV создался
  const wavStats = await fs.stat(wavFile);
  console.log(`✅ WAV created: ${(wavStats.size / 1024).toFixed(2)} KB`);
}

/**
 * Транскрибировать WAV через локальный faster-whisper (Python)
 */
export async function transcribeAudio(wavFile, language = 'ru') {
  // Проверяем размер файла
  const stats = await fs.stat(wavFile);
  console.log(`📊 WAV file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  
  if (stats.size === 0) {
    console.warn(`⚠️  WAV file is empty: ${wavFile}`);
    return '';
  }

  console.log(`🎤 Transcribing ${wavFile} via local Whisper...`);
  
  try {
    const whisperScript = path.join(projectRoot, 'whisper_transcribe.py');
    const modelSize = process.env.WHISPER_MODEL || 'base'; // tiny, base, small, medium, large-v3
    
    // Ищем python3.10 (где установлен faster-whisper)
    const pythonCmd = process.env.PYTHON_CMD || 'python3.10';
    
    const { stdout, stderr } = await exec(pythonCmd, [
      whisperScript,
      wavFile,
      language,
      modelSize
    ]);

    if (stderr) {
      console.log(`   ${stderr.trim()}`);
    }

    const result = JSON.parse(stdout);
    console.log(`✅ Transcription complete, length: ${result.text?.length || 0} chars`);
    return result.text || '';
    
  } catch (error) {
    console.error(`❌ Transcription error for ${wavFile}:`, error.message);
    if (error.stderr) {
      console.error(`   stderr: ${error.stderr}`);
    }
    return '';
  }
}

/**
 * Транскрибировать все файлы участников и собрать единую расшифровку
 * с временными метками и идентификаторами спикеров.
 */
export async function transcribeSession(userFiles, sessionDir, onProgress = null) {
  const transcriptsDir = path.join(sessionDir, 'transcripts');
  await ensureDir(transcriptsDir);

  const segments = [];
  const totalUsers = userFiles.length;

  console.log(`📝 Transcribing ${totalUsers} user(s)...`);

  for (let i = 0; i < userFiles.length; i++) {
    const { userId, userName, pcmFile, startOffset } = userFiles[i];
    const displayName = userName || `User_${userId}`;
    
    // Calculate progress: 0-80% for transcription (leave 10% for summarizing, 10% for final)
    const progressPercent = Math.round((i / totalUsers) * 80);
    if (onProgress) {
      await onProgress(progressPercent, displayName);
    }
    
    console.log(`\n👤 Processing ${displayName} (${i + 1}/${totalUsers})...`);
    const wavFile = path.join(transcriptsDir, `${userId}.wav`);
    
    try {
      await pcmToWav(pcmFile, wavFile);
      
      // Проверяем что WAV файл существует и не пустой
      const wavStats = await fs.stat(wavFile);
      if (wavStats.size === 0) {
        console.warn(`⚠️  Skipping empty WAV for ${displayName}`);
        continue;
      }

      const text = await transcribeAudio(wavFile, process.env.WHISPER_LANGUAGE || 'ru');

      if (text.trim()) {
        segments.push({
          userId,
          userName: displayName,
          offsetMs: startOffset,
          text: text.trim(),
        });
        console.log(`✅ ${displayName}: "${text.substring(0, 50)}..."`);
      } else {
        console.warn(`⚠️  No transcription for ${displayName}`);
      }
    } catch (error) {
      console.error(`❌ Error processing ${displayName}:`, error.message);
      // Продолжаем со следующим пользователем
    }
  }

  // Progress 80% - all transcriptions done
  if (onProgress) {
    await onProgress(80, '');
  }

  console.log(`\n📊 Total segments: ${segments.length}`);

  // Сортировать по времени старта записи участника
  segments.sort((a, b) => a.offsetMs - b.offsetMs);

  // Use display names in transcript
  const transcript = segments.map((seg) => `[${seg.userName}] ${seg.text}`).join('\n');
  
  if (!transcript.trim()) {
    throw new Error('Нет транскрипции. Возможно аудио было слишком коротким или тихим.');
  }

  return transcript;
}
