import { VoiceReceiver } from '@discordjs/voice';
import { createWriteStream } from 'fs';
import { Writable } from 'stream';
import path from 'path';
import { ensureDir, sleep } from './utils.js';
import { transcribeSession } from './transcribe.js';
import { summarizeTranscript } from './summarize.js';

/**
 * Начать многоканальную запись.
 * Возвращает объект сессии с connection, receiver, спикерами и временем старта.
 */
export async function startRecording(connection, voiceChannel, outputDir) {
  const sessionDir = path.join(outputDir, `session_${Date.now()}`);
  await ensureDir(sessionDir);

  const receiver = connection.receiver;
  const userStreams = new Map();
  const startTime = Date.now();

  connection.on('stateChange', (oldState, newState) => {
    console.log(`Connection state: ${oldState.status} -> ${newState.status}`);
  });

  receiver.speaking.on('start', (userId) => {
    if (userStreams.has(userId)) return;

    const pcmFile = path.join(sessionDir, `${userId}.pcm`);
    const writeStream = createWriteStream(pcmFile);
    userStreams.set(userId, { pcmFile, writeStream, start: Date.now() });

    const audioStream = receiver.subscribe(userId, {
      end: {
        behavior: 'silence',
        duration: 1000,
      },
    });

    const opusDecoder = new Writable({
      write(chunk, _encoding, callback) {
        writeStream.write(chunk, callback);
      },
    });

    audioStream.pipe(opusDecoder);

    audioStream.on('end', () => {
      writeStream.end();
    });

    console.log(`Started recording user ${userId}`);
  });

  receiver.speaking.on('end', (userId) => {
    const stream = userStreams.get(userId);
    if (stream) {
      stream.writeStream.end();
      console.log(`Stopped recording user ${userId}`);
    }
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
