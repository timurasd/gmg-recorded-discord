import { VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { createWriteStream } from 'fs';
import fs from 'fs/promises';
import { pipeline } from 'stream';
import { promisify } from 'util';
import path from 'path';
import prism from 'prism-media';
import { ensureDir, sleep } from './utils.js';
import { transcribeSession } from './transcribe.js';
import { summarizeTranscript } from './summarize.js';
import { updateProgress } from './delivery.js';

const pipelineAsync = promisify(pipeline);

/**
 * Начать многоканальную запись.
 * Возвращает объект сессии с connection, receiver, спикерами и временем старта.
 */
export async function startRecording(connection, voiceChannel, outputDir) {
  const sessionDir = path.join(outputDir, `session_${Date.now()}`);
  await ensureDir(sessionDir);

  const userStreams = new Map();
  const userNames = new Map(); // userId -> display name
  const startTime = Date.now();

  console.log(`📁 Session directory: ${sessionDir}`);
  console.log(`👥 Users in voice channel: ${voiceChannel.members.size}`);
  
  // Collect initial participants (excluding bots)
  voiceChannel.members.forEach(member => {
    if (!member.user.bot) {
      userNames.set(member.id, member.displayName || member.user.username);
      console.log(`   - ${member.displayName} (${member.id})`);
    }
  });

  connection.on('stateChange', (oldState, newState) => {
    console.log(`Connection state: ${oldState.status} -> ${newState.status}`);
  });

  connection.on('error', (error) => {
    console.error(`❌ Connection error:`, error);
  });

  // Ждём пока connection станет Ready
  console.log(`⏳ Waiting for connection to be ready...`);
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
    console.log(`✅ Connection is ready!`);
  } catch (error) {
    console.error(`❌ Failed to enter ready state:`, error.message);
    throw new Error('Voice connection failed to become ready within 20 seconds');
  }

  const receiver = connection.receiver;
  console.log(`🎧 Receiver created:`, receiver ? 'YES' : 'NO');
  console.log(`🔊 Receiver.speaking:`, receiver.speaking ? 'YES' : 'NO');

  // Диагностика: выводим все события
  console.log(`📡 Setting up speaking listeners...`);
  
  receiver.speaking.on('start', (userId) => {
    console.log(`🎤 User ${userId} started speaking`);
    
    // Проверяем есть ли активная запись для этого юзера
    const existingStream = userStreams.get(userId);
    if (existingStream && existingStream.isActive) {
      console.log(`⚠️  User ${userId} already recording, skipping`);
      return;
    }

    // Создаём файл для записи (с флагом 'a' для append если файл уже есть)
    const pcmFile = path.join(sessionDir, `${userId}.pcm`);
    const isNewFile = !existingStream;
    const writeStream = createWriteStream(pcmFile, { flags: 'a' }); // append mode!
    
    const streamInfo = { 
      pcmFile, 
      writeStream, 
      start: existingStream?.start || Date.now(), // сохраняем оригинальное время старта
      bytesWritten: existingStream?.bytesWritten || 0,
      isActive: true
    };
    userStreams.set(userId, streamInfo);

    // Subscribe to user's audio (returns Opus stream)
    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: 'silence',
        duration: 1000,
      },
    });

    console.log(`✅ Subscribed to Opus stream for user ${userId}${isNewFile ? ' (new file)' : ' (appending)'}`);

    // Decode Opus → PCM (16-bit signed little-endian, 48kHz, stereo)
    const opusDecoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: 2,
      rate: 48000,
    });

    // Pipe: Opus → PCM Decoder → File
    opusStream.pipe(opusDecoder).pipe(writeStream);

    // Когда поток заканчивается - помечаем как неактивный, но НЕ удаляем
    // чтобы при следующем speaking событии дописывать в тот же файл
    opusStream.on('end', () => {
      const stream = userStreams.get(userId);
      if (stream) {
        stream.isActive = false;
        console.log(`🛑 Opus stream ended for user ${userId}, ready to append on next speech`);
      }
    });

    opusStream.on('error', (err) => {
      console.error(`❌ Opus stream error for user ${userId}:`, err.message);
      const stream = userStreams.get(userId);
      if (stream) stream.isActive = false;
    });

    opusDecoder.on('error', (err) => {
      console.error(`❌ Opus decoder error for user ${userId}:`, err.message);
      // Не останавливаем запись при единичных ошибках декодера
    });

    console.log(`📼 ${isNewFile ? 'Started' : 'Resumed'} recording user ${userId} to ${pcmFile}`);
  });

  receiver.speaking.on('end', (userId) => {
    console.log(`🔇 User ${userId} stopped speaking`);
  });

  return {
    connection,
    voiceChannel,
    sessionDir,
    userStreams,
    userNames,
    startTime,
  };
}

/**
 * Get session info for progress messages
 */
export async function getSessionInfo(session) {
  const { userStreams, userNames, startTime } = session;
  
  const durationMin = Math.round((Date.now() - startTime) / 60000);
  const speakerCount = userStreams.size;
  const participants = Array.from(userNames.values());
  
  // Calculate total file size
  let totalSize = 0;
  for (const [, info] of userStreams.entries()) {
    try {
      const stats = await fs.stat(info.pcmFile);
      totalSize += stats.size;
    } catch {}
  }
  
  // Estimate WAV size (PCM 48kHz stereo -> WAV 16kHz mono = ~6x smaller)
  const estimatedWavSize = totalSize / 6;
  // Estimate: 1MB WAV ≈ 30 sec transcription on CPU with small model
  const estimatedMin = Math.ceil(Math.max(1, (estimatedWavSize / 1024 / 1024) * 0.5));
  
  return {
    durationMin,
    speakerCount,
    totalSize,
    estimatedMin,
    participants,
  };
}

/**
 * Остановить запись и запустить транскрипцию + summary.
 */
export async function stopRecording(session) {
  const { connection, userStreams, userNames, sessionDir, startTime } = session;

  console.log(`🛑 Stopping recording, ${userStreams.size} users recorded`);

  // Сначала закрываем все writeStream'ы явно
  const closePromises = [];
  for (const [userId, info] of userStreams.entries()) {
    if (info.writeStream && !info.writeStream.destroyed) {
      closePromises.push(new Promise((resolve) => {
        info.writeStream.end(() => {
          console.log(`📁 Closed file for user ${userId}`);
          resolve();
        });
      }));
    }
  }
  
  // Ждём закрытия всех файлов
  await Promise.all(closePromises);
  
  // Потом отключаемся от голосового канала
  connection.destroy();

  // Даём системе время на flush
  await sleep(500);

  const userFiles = [];
  for (const [userId, info] of userStreams.entries()) {
    const userName = userNames.get(userId) || `User_${userId}`;
    userFiles.push({ userId, userName, pcmFile: info.pcmFile, startOffset: info.start - startTime });
  }

  if (userFiles.length === 0) {
    throw new Error('Нет записанных аудиопотоков.');
  }

  console.log(`📝 Transcribing ${userFiles.length} user(s)...`);
  
  // Update progress: 0% starting transcription
  await updateProgress(0, '', 'transcribing');
  
  const transcript = await transcribeSession(userFiles, sessionDir, async (progress, userName) => {
    await updateProgress(progress, userName, 'transcribing');
  });

  // Update progress: 90% summarizing
  await updateProgress(90, '', 'summarizing');
  
  console.log('🤖 Summarizing...');
  const summary = await summarizeTranscript(transcript);
  
  // Update progress: 100% done
  await updateProgress(100, '', 'done');

  // Get participant names
  const participants = Array.from(userNames.values());

  return {
    sessionDir,
    transcript,
    summary,
    participants,
    durationSec: Math.round((Date.now() - startTime) / 1000),
  };
}
