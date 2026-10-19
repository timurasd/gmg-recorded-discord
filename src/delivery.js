import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import FormData from 'form-data';

const TG_TEXT_LIMIT = 4000; // Telegram allows 4096; leave room for HTML entities
const DISCORD_TEXT_LIMIT = 1900;

export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h} ч ${m} мин`;
  if (m > 0) return `${m} мин ${s} сек`;
  return `${s} сек`;
}

export function formatMoscowTime(ms) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ms)) + ' МСК';
}

function buildProgressBar(percent) {
  const filled = Math.floor(percent / 5);
  return '[' + '█'.repeat(filled) + '░'.repeat(20 - filled) + '] ' + percent + '%';
}

/** Split text into pieces of at most `limit` chars, on line breaks when possible. */
export function splitText(text, limit) {
  const parts = [];
  let rest = String(text);
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

// ---------- Telegram ----------

function tgConfig() {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  return chatId && token ? { chatId, token } : null;
}

async function tgCall(method, payload) {
  const cfg = tgConfig();
  if (!cfg) return null;
  const res = await axios.post(`https://api.telegram.org/bot${cfg.token}/${method}`, { chat_id: cfg.chatId, ...payload });
  return res.data?.result ?? null;
}

async function tgUpload(method, field, filePath, filename, extra = {}) {
  const cfg = tgConfig();
  if (!cfg) return null;
  const form = new FormData();
  form.append('chat_id', cfg.chatId);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  form.append(field, await fs.readFile(filePath), { filename });
  const res = await axios.post(`https://api.telegram.org/bot${cfg.token}/${method}`, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return res.data?.result ?? null;
}

/** Plain HTML message to the Telegram chat; errors are logged, not thrown. */
export async function sendTelegramText(html) {
  try {
    return await tgCall('sendMessage', { text: html, parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    console.error('❌ Telegram: sendMessage failed:', err.response?.data?.description || err.message);
    return null;
  }
}

export async function notifyRecordingStart(channelName, participants = []) {
  const names = participants.map(escapeHtml).join(', ') || 'пока никого';
  await sendTelegramText(`🔴 <b>Запись началась</b>\n\n📢 Канал: ${escapeHtml(channelName)}\n👥 В канале: ${names}`);
}

/** Returns the id of the message that then shows processing progress. */
export async function notifyRecordingEnd({ durationMin, speakerCount }) {
  const msg = await sendTelegramText([
    `⏹️ <b>Запись закончена</b>`,
    ``,
    `⏱ Длительность: <b>${durationMin} мин</b>`,
    `🎤 Говорили: <b>${speakerCount}</b>`,
    ``,
    `⏳ Расшифровываю. Час разговора — примерно 20–40 минут обработки.`,
  ].join('\n'));
  return msg?.message_id ?? null;
}

export async function updateProgress(messageId, percent, label) {
  if (!messageId) return;
  try {
    await tgCall('editMessageText', {
      message_id: messageId,
      parse_mode: 'HTML',
      text: [`⏳ <b>Обработка записи</b>`, ``, `<code>${buildProgressBar(percent)}</code>`, ``, escapeHtml(label)].join('\n'),
    });
  } catch (err) {
    const desc = err.response?.data?.description || err.message;
    if (!String(desc).includes('message is not modified')) console.error('❌ Telegram: progress update failed:', desc);
  }
}

/**
 * Deliver a processed meeting: summary as text, transcript as a file.
 * The transcript goes out even when the summary failed.
 */
export async function sendResults({ transcriptPath, summary, summaryError, participants = [], durationSec, startTime, interrupted, progressMessageId }) {
  const when = formatMoscowTime(startTime);
  const who = participants.join(', ') || 'неизвестно';
  // Moscow wall clock in the file name: transcript_2026-10-19_14-03.txt
  const fileName = `transcript_${new Date(startTime + 3 * 3600_000).toISOString().slice(0, 16).replace('T', '_').replace(':', '-')}.txt`;
  const warn = interrupted
    ? '⚠️ Запись прервалась (обрыв связи или перезапуск бота) — обработано то, что успело записаться.'
    : '';

  // Telegram
  if (tgConfig()) {
    const header = [`✅ <b>Созвон ${escapeHtml(when)}</b>`, `👥 ${escapeHtml(who)}`, `⏱ ${formatDuration(durationSec)}`, warn && `\n${warn}`]
      .filter(Boolean).join('\n');
    const body = summary
      ? escapeHtml(summary)
      : `⚠️ Сводку сделать не получилось: ${escapeHtml(summaryError || 'неизвестная ошибка')}. Расшифровка — в файле ниже.`;
    const footer = '🎧 Сама запись разговора — командой <code>!audio</code> в Discord.';
    const parts = splitText(`${header}\n\n${body}\n\n${footer}`, TG_TEXT_LIMIT);
    for (const part of parts) await sendTelegramText(part);
    try {
      await tgUpload('sendDocument', 'document', transcriptPath, fileName, { caption: `Расшифровка, ${when}` });
      console.log('✅ Telegram: transcript sent');
    } catch (err) {
      console.error('❌ Telegram: transcript upload failed:', err.response?.data?.description || err.message);
    }
    if (progressMessageId) {
      try {
        await tgCall('editMessageText', { message_id: progressMessageId, text: '✅ Обработка закончена, результат ниже.' });
      } catch { /* not important */ }
    }
  } else {
    console.log('⚠️ Telegram: no TELEGRAM_CHAT_ID / TELEGRAM_BOT_TOKEN, skipping');
  }

  // Discord summary channel
  const channelId = process.env.DISCORD_SUMMARY_CHANNEL_ID;
  if (channelId) {
    try {
      const head = [`**Созвон ${when}**`, `👥 ${who}`, `⏱ ${formatDuration(durationSec)}`, warn].filter(Boolean).join('\n');
      const text = summary || `⚠️ Сводку сделать не получилось: ${summaryError || 'неизвестная ошибка'}.`;
      const full = `${head}\n\n${text}`;
      await sendDiscordMessage(channelId, full.length <= DISCORD_TEXT_LIMIT ? full : `${head}\n\nСводка и расшифровка — в файлах.`);
      if (summary && full.length > DISCORD_TEXT_LIMIT) {
        const summaryPath = path.join(path.dirname(transcriptPath), 'summary.txt');
        await sendDiscordFile(channelId, summaryPath, 'summary.txt');
      }
      await sendDiscordFile(channelId, transcriptPath, fileName);
    } catch (err) {
      console.error('❌ Discord: summary delivery failed:', err.response?.data?.message || err.message);
    }
  }
}

/** Send the meeting audio (one or more mp3 parts) to the Telegram chat. */
export async function sendAudioFiles(files, caption) {
  for (let i = 0; i < files.length; i++) {
    const name = path.basename(files[i]);
    const partCaption = files.length > 1 ? `${caption} (часть ${i + 1} из ${files.length})` : caption;
    await tgUpload('sendAudio', 'audio', files[i], name, { caption: partCaption, title: partCaption });
    console.log(`✅ Telegram: audio ${name} sent`);
  }
}

// ---------- Discord REST ----------

async function sendDiscordMessage(channelId, content) {
  await axios.post(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    { content },
    { headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' } },
  );
}

async function sendDiscordFile(channelId, filePath, filename) {
  const form = new FormData();
  form.append('file', await fs.readFile(filePath), { filename });
  await axios.post(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    form,
    { headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}`, ...form.getHeaders() } },
  );
}
