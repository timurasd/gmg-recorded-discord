import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';

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
 * Notify Telegram that recording has started
 */
export async function notifyRecordingStart(voiceChannel) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!chatId || !token) return;

  const channelName = escapeHtml(voiceChannel.name);
  const message = `🔴 <b>Запись началась</b>\n\n📢 Канал: ${channelName}\n🆔 ID: ${voiceChannel.id}`;
  
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

/**
 * Notify Telegram that recording has ended and processing started
 */
export async function notifyRecordingEnd() {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!chatId || !token) return;

  const message = `⏸️ <b>Запись остановлена</b>\n\n⏳ Обработка началась (транскрипция + саммаризация)...`;
  
  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
      },
    );
    console.log('✅ Telegram: уведомление об окончании записи отправлено');
  } catch (err) {
    console.error('❌ Telegram: ошибка при отправке уведомления об окончании:', err.message);
  }
}

/**
 * Отправить сводку и полную расшифровку в Discord и Telegram.
 */
export async function sendResults(result) {
  const { summary, transcript, sessionDir, durationSec } = result;

  const transcriptPath = path.join(sessionDir, 'transcript.txt');
  const summaryPath = path.join(sessionDir, 'summary.txt');

  await fs.writeFile(transcriptPath, transcript, 'utf-8');
  await fs.writeFile(summaryPath, summary, 'utf-8');

  await sendToDiscord(summary, transcript, durationSec, transcriptPath, summaryPath);
  await sendToTelegram(summary, transcript, durationSec, transcriptPath, summaryPath, sessionDir);
}

async function sendToDiscord(summary, transcript, durationSec, transcriptPath, summaryPath) {
  const channelId = process.env.DISCORD_SUMMARY_CHANNEL_ID;
  if (!channelId) return;

  // Discord limit: 2000 chars. If summary is too long, just send a short message
  const MAX_LENGTH = 1800; // leave some space for header
  let discordMessage;
  
  if (summary.length > MAX_LENGTH) {
    // Send short notification + files
    discordMessage = `**Сводка созвона** (${formatDuration(durationSec)})\n\n✅ Обработка завершена. Полная сводка в прикреплённых файлах.`;
  } else {
    // Send full summary if it fits
    discordMessage = `**Сводка созвона** (${formatDuration(durationSec)})\n\n${summary}`;
  }

  await sendDiscordMessage(channelId, discordMessage);

  // Отправить файлы
  await sendDiscordFile(channelId, summaryPath, 'summary.txt');
  await sendDiscordFile(channelId, transcriptPath, 'transcript.txt');
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

async function sendToTelegram(summary, transcript, durationSec, transcriptPath, summaryPath, sessionDir) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!chatId || !token) {
    console.log('⚠️ Telegram: нет TELEGRAM_CHAT_ID или TELEGRAM_BOT_TOKEN, пропускаю');
    return;
  }

  console.log('📤 Telegram: отправка результатов...');

  // Send completion notification
  const notificationMessage = `✅ <b>Обработка завершена</b> (${formatDuration(durationSec)})\n\n📄 Отправляю файлы...`;
  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        chat_id: chatId,
        text: notificationMessage,
        parse_mode: 'HTML',
      },
    );
  } catch (err) {
    console.error('❌ Telegram: ошибка при отправке уведомления о завершении:', err.message);
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
  const transcriptsDir = path.join(sessionDir, 'transcripts');
  try {
    const files = await fs.readdir(transcriptsDir);
    const wavFiles = files.filter(f => f.endsWith('.wav'));
    
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
  } catch (err) {
    console.error('❌ Telegram: ошибка при чтении WAV файлов:', err.message);
  }

  console.log('✅ Telegram: все файлы отправлены');
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}м ${s.toString().padStart(2, '0')}с`;
}
