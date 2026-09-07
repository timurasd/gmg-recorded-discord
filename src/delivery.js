import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

// Store message IDs for editing
let progressMessageId = null;

/**
 * Escape HTML special characters
 */
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Get next meeting number
 */
async function getNextMeetingNumber() {
  const counterFile = path.join(projectRoot, 'meeting_counter.txt');
  try {
    const data = await fs.readFile(counterFile, 'utf-8');
    const num = parseInt(data.trim(), 10) + 1;
    await fs.writeFile(counterFile, String(num), 'utf-8');
    return num;
  } catch {
    await fs.writeFile(counterFile, '1', 'utf-8');
    return 1;
  }
}

/**
 * Format file size
 */
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Estimate transcription time based on audio size
 * Rough estimate: 1 MB WAV ≈ 1 minute audio ≈ 30 sec transcription (small model on CPU)
 */
function estimateTranscriptionTime(totalWavBytes) {
  const minutes = totalWavBytes / (1024 * 1024); // approx minutes of audio
  const transcriptionMinutes = minutes * 0.5; // rough estimate
  return Math.ceil(Math.max(1, transcriptionMinutes));
}

/**
 * Build progress bar
 */
function buildProgressBar(percent) {
  const filled = Math.floor(percent / 5);
  const empty = 20 - filled;
  return '[' + '█'.repeat(filled) + '░'.repeat(empty) + '] ' + percent + '%';
}

/**
 * Notify Telegram and Discord that recording has started
 */
export async function notifyRecordingStart(voiceChannel, participants = []) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  const channelName = escapeHtml(voiceChannel.name);
  const participantNames = participants.map(p => escapeHtml(p)).join(', ') || 'ожидание...';
  
  const message = `🔴 <b>Запись началась</b>\n\n📢 Канал: ${channelName}\n👥 Участники: ${participantNames}`;
  
  if (chatId && token) {
    try {
      await axios.post(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
        },
      );
      console.log('✅ Telegram: уведомление о начале записи отправлено');
    } catch (err) {
      console.error('❌ Telegram: ошибка при отправке уведомления о начале:', err.message);
    }
  }
}

/**
 * Notify Telegram that recording has ended and processing started
 */
export async function notifyRecordingEnd(sessionInfo) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!chatId || !token) return null;

  const { durationMin, speakerCount, totalSize, estimatedMin } = sessionInfo;
  
  const message = [
    `⏹️ <b>Запись закончена</b>`,
    ``,
    `⏱ Длительность: <b>${durationMin} мин</b>`,
    `🎤 Спикеров: <b>${speakerCount}</b>`,
    `💾 Размер: <b>${formatSize(totalSize)}</b>`,
    ``,
    `⏳ Приступаю к транскрипции и суммаризации`,
    `📊 Ориентировочно: <b>~${estimatedMin} мин</b>`,
  ].join('\n');
  
  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      },
    );
    console.log('✅ Telegram: уведомление об окончании записи отправлено');
    progressMessageId = response.data?.result?.message_id;
    return progressMessageId;
  } catch (err) {
    console.error('❌ Telegram: ошибка при отправке уведомления об окончании:', err.message);
    return null;
  }
}

/**
 * Update progress message in Telegram
 */
export async function updateProgress(percent, currentUser = '', status = 'transcribing') {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!chatId || !token || !progressMessageId) return;

  const progressBar = buildProgressBar(percent);
  const statusText = status === 'transcribing' 
    ? `🎤 Транскрибирую: ${currentUser}`
    : status === 'summarizing'
    ? `🤖 Генерирую саммари...`
    : `✅ Готово!`;
  
  const message = [
    `⏳ <b>Обработка записи</b>`,
    ``,
    `<code>${progressBar}</code>`,
    ``,
    statusText,
  ].join('\n');
  
  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/editMessageText`,
      {
        chat_id: chatId,
        message_id: progressMessageId,
        text: message,
        parse_mode: 'HTML',
      },
    );
  } catch (err) {
    // Ignore "message is not modified" errors
    if (!err.message?.includes('message is not modified')) {
      console.error('❌ Telegram: ошибка обновления прогресса:', err.message);
    }
  }
}

/**
 * Отправить сводку и полную расшифровку в Discord и Telegram.
 */
export async function sendResults(result) {
  const { summary, transcript, sessionDir, durationSec, participants = [] } = result;

  const transcriptPath = path.join(sessionDir, 'transcript.txt');
  const summaryPath = path.join(sessionDir, 'summary.txt');

  await fs.writeFile(transcriptPath, transcript, 'utf-8');
  await fs.writeFile(summaryPath, summary, 'utf-8');

  const meetingNumber = await getNextMeetingNumber();

  await sendToDiscord(summary, transcript, durationSec, transcriptPath, summaryPath, meetingNumber, participants);
  await sendToTelegram(summary, transcript, durationSec, transcriptPath, summaryPath, sessionDir, meetingNumber, participants);
}

async function sendToDiscord(summary, transcript, durationSec, transcriptPath, summaryPath, meetingNumber, participants) {
  const channelId = process.env.DISCORD_SUMMARY_CHANNEL_ID;
  if (!channelId) return;

  const participantList = participants.length > 0 ? participants.join(', ') : 'N/A';
  
  // Extract one-line discussion summary from Claude's summary (first paragraph usually)
  const discussionLine = extractDiscussionLine(summary);

  // Discord limit: 2000 chars. If summary is too long, just send a short message
  const MAX_LENGTH = 1600;
  
  const header = [
    `**Встреча #${meetingNumber}**`,
    `👥 Участники: ${participantList}`,
    `⏱ Длительность: ${formatDuration(durationSec)}`,
    `💬 Обсуждение: ${discussionLine}`,
    ``,
    `📎 Файлы прикреплены ниже`,
  ].join('\n');

  let discordMessage;
  if (summary.length > MAX_LENGTH) {
    discordMessage = header;
  } else {
    discordMessage = header + '\n\n---\n\n' + summary;
  }

  await sendDiscordMessage(channelId, discordMessage);

  // Отправить файлы
  await sendDiscordFile(channelId, summaryPath, 'summary.txt');
  await sendDiscordFile(channelId, transcriptPath, 'transcript.txt');
}

/**
 * Extract a one-line discussion summary from full summary
 */
function extractDiscussionLine(summary) {
  // Try to get first meaningful sentence
  const lines = summary.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('-'));
  const firstLine = lines[0] || summary.substring(0, 200);
  // Truncate to ~150 chars
  if (firstLine.length > 150) {
    return firstLine.substring(0, 147) + '...';
  }
  return firstLine;
}

async function sendDiscordMessage(channelId, content) {
  const token = process.env.DISCORD_TOKEN;
  await axios.post(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    { content },
    {
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
    },
  );
}

async function sendDiscordFile(channelId, filePath, filename) {
  const token = process.env.DISCORD_TOKEN;
  const form = new (await import('form-data')).default();
  form.append('file', await fs.readFile(filePath), { filename });

  await axios.post(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    form,
    {
      headers: {
        Authorization: `Bot ${token}`,
        ...form.getHeaders(),
      },
    },
  );
}

async function sendToTelegram(summary, transcript, durationSec, transcriptPath, summaryPath, sessionDir, meetingNumber, participants) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!chatId || !token) {
    console.log('⚠️ Telegram: нет TELEGRAM_CHAT_ID или TELEGRAM_BOT_TOKEN, пропускаю');
    return;
  }

  console.log('📤 Telegram: отправка результатов...');

  const participantList = participants.length > 0 ? participants.map(p => escapeHtml(p)).join(', ') : 'N/A';
  const discussionLine = escapeHtml(extractDiscussionLine(summary));

  // Count WAV files
  const transcriptsDir = path.join(sessionDir, 'transcripts');
  let wavFiles = [];
  try {
    const files = await fs.readdir(transcriptsDir);
    wavFiles = files.filter(f => f.endsWith('.wav'));
  } catch {}

  // Send final summary message
  const finalMessage = [
    `✅ <b>Встреча #${meetingNumber}</b>`,
    ``,
    `👥 Участники: ${participantList}`,
    `⏱ Длительность: ${formatDuration(durationSec)}`,
    `💬 Обсуждение: ${discussionLine}`,
    ``,
    `📎 Прикрепляю файлы ниже:`,
  ].join('\n');

  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        chat_id: chatId,
        text: finalMessage,
        parse_mode: 'HTML',
      },
    );
  } catch (err) {
    console.error('❌ Telegram: ошибка при отправке финального сообщения:', err.message);
  }

  // Send summary and transcript files
  for (const file of [summaryPath, transcriptPath]) {
    const filename = path.basename(file);
    console.log(`📄 Telegram: отправка ${filename}...`);
    try {
      const form = new (await import('form-data')).default();
      form.append('document', await fs.readFile(file), { filename });
      form.append('chat_id', chatId);

      await axios.post(
        `https://api.telegram.org/bot${token}/sendDocument`,
        form,
        {
          headers: form.getHeaders(),
        },
      );
      console.log(`✅ Telegram: ${filename} отправлен`);
    } catch (err) {
      console.error(`❌ Telegram: ошибка при отправке ${filename}:`, err.message);
    }
  }

  // Send all WAV files from transcripts/ directory
  console.log(`🎵 Telegram: найдено ${wavFiles.length} WAV файлов`);
  
  for (const wavFile of wavFiles) {
    const wavPath = path.join(transcriptsDir, wavFile);
    console.log(`🎵 Telegram: отправка ${wavFile}...`);
    
    try {
      const form = new (await import('form-data')).default();
      form.append('document', await fs.readFile(wavPath), { filename: wavFile });
      form.append('chat_id', chatId);

      await axios.post(
        `https://api.telegram.org/bot${token}/sendDocument`,
        form,
        {
          headers: form.getHeaders(),
        },
      );
      console.log(`✅ Telegram: ${wavFile} отправлен`);
    } catch (err) {
      console.error(`❌ Telegram: ошибка при отправке ${wavFile}:`, err.message);
    }
  }

  console.log('✅ Telegram: все файлы отправлены');
  
  // Reset progress message ID
  progressMessageId = null;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}м ${s.toString().padStart(2, '0')}с`;
}
