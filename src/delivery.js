import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';

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
  await sendToTelegram(summary, transcript, durationSec, transcriptPath, summaryPath);
}

async function sendToDiscord(summary, transcript, durationSec, transcriptPath, summaryPath) {
  const channelId = process.env.DISCORD_SUMMARY_CHANNEL_ID;
  if (!channelId) return;

  const discordMessage = `**Сводка созвона** (${formatDuration(durationSec)})\n\n${summary}`;

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

async function sendToTelegram(summary, transcript, durationSec, transcriptPath, summaryPath) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!chatId || !token) return;

  const message = `*Сводка созвона* (${formatDuration(durationSec)})\n\n${summary}`;
  await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown',
    },
  );

  for (const file of [summaryPath, transcriptPath]) {
    const filename = path.basename(file);
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
  }
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}м ${s.toString().padStart(2, '0')}с`;
}
