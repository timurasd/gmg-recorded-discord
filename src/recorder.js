import { VoiceConnectionStatus, entersState } from '@discordjs/voice';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream';
import { promisify } from 'util';
import path from 'path';
import prism from 'prism-media';
import { ensureDir, sleep } from './utils.js';
import { transcribeSession } from './transcribe.js';
import { summarizeTranscript } from './summarize.js';

const pipelineAsync = promisify(pipeline);

/**
 * Начать многоканальную запись.
 * Возвращает объект сессии с connection, receiver, спикерами и временем старта.
 */
export async function startRecording(connection, voiceChannel, outputDir) {
  const sessionDir = path.join(outputDir, `session_${Date.now()}`);
  await ensureDir(sessionDir);

  const userStreams = new Map();
  const startTime = Date.now();

  console.log(`📁 Session directory: ${sessionDir}`);
  console.log(`👥 Users in voice channel: ${voiceChannel.members.size}`);
  voiceChannel.members.forEach(member => {
    console.log(`   - ${member.user.tag} (${member.id})`);
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
    
    if (userStreams.has(userId)) {
      console.log(`⚠️  User ${userId} already recording, skipping`);
      return;
    }

    const pcmFile = path.join(sessionDir, `${userId}.pcm`);
    const writeStream = createWriteStream(pcmFile);
    userStreams.set(userId, { pcmFile, writeStream, start: Date.now(), bytesWritten: 0 });

    // Subscribe to user's audio (returns Opus stream)
    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: 'silence',
        duration: 1000,
      },
    });

    console.log(`✅ Subscribed to Opus stream for user ${userId}`);

    // Decode Opus → PCM (16-bit signed little-endian, 48kHz, stereo)
    const opusDecoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: 2,
      rate: 48000,
    });

    // Pipe: Opus → PCM Decoder → File
    opusStream.pipe(opusDecoder).pipe(writeStream);

    opusStream.on('end', () => {
      const stream = userStreams.get(userId);
      console.log(`🛑 Opus stream ended for user ${userId}`);
      // writeStream закроется автоматически через pipe
    });

    opusStream.on('error', (err) => {
      console.error(`❌ Opus stream error for user ${userId}:`, err);
    });

    opusDecoder.on('error', (err) => {
      console.error(`❌ Opus decoder error for user ${userId}:`, err);
    });

    console.log(`📼 Started recording user ${userId} to ${pcmFile}`);
  });

  receiver.speaking.on('end', (userId) => {
    console.log(`🔇 User ${userId} stopped speaking`);
  });

  return {
    connection,
    voiceChannel,
    sessionDir,
    userStreams,
    startTime,
  };
}

/**
 * Остановить запись и запустить транскрипцию + summary.
 */
export async function stopRecording(session) {
  const { connection, userStreams, sessionDir, startTime } = session;

  connection.destroy();

  // Дождаться закрытия файлов
  await sleep(1000);

  const userFiles = [];
  for (const [userId, info] of userStreams.entries()) {
    userFiles.push({ userId, pcmFile: info.pcmFile, startOffset: info.start - startTime });
  }

  if (userFiles.length === 0) {
    throw new Error('Нет записанных аудиопотоков.');
  }

  console.log('Transcribing session...');
  const transcript = await transcribeSession(userFiles, sessionDir);

  console.log('Summarizing...');
  const summary = await summarizeTranscript(transcript);

  return {
    sessionDir,
    transcript,
    summary,
    durationSec: Math.round((Date.now() - startTime) / 1000),
  };
}
