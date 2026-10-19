import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { joinVoiceChannel } from '@discordjs/voice';
import { SessionManager, updateSessionFile, listProcessedSessions } from './recorder/session-manager.js';
import { AudioRecorder } from './recorder/audio-recorder.js';
import { RecoveryService } from './services/recovery.js';
import { Watchdog } from './services/watchdog.js';
import { processSession } from './pipeline.js';
import { buildMixedAudio } from './mix.js';
import {
  notifyRecordingStart, notifyRecordingEnd, sendTelegramText, sendAudioFiles,
  escapeHtml, formatDuration, formatMoscowTime,
} from './delivery.js';
import { ensureDir } from './utils.js';

const VERSION = '3.0.0';
const LOGIN_RETRY_DELAY_MS = 5 * 60_000;

const recordingsDir = process.env.AUDIO_OUTPUT_DIR || './recordings';
await ensureDir(recordingsDir);

const sessionManager = new SessionManager(recordingsDir);
const recoveryService = new RecoveryService(recordingsDir, sessionManager);

let activeRecording = null;
let busyJobs = 0; // processing or building audio

// One heavy job at a time: Whisper takes the whole CPU of this droplet.
let queue = Promise.resolve();
function enqueue(job) {
  busyJobs++;
  const run = queue.then(job).catch((err) => console.error('[Queue] Job failed:', err)).finally(() => { busyJobs--; });
  queue = run;
  return run;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

function saveEverything() {
  if (activeRecording) activeRecording._emergencySave();
  sessionManager.emergencySaveAll();
}

const watchdog = new Watchdog({
  isConnected: () => client.isReady(),
  isBusy: () => Boolean(activeRecording) || busyJobs > 0,
  onFatal: (reason) => {
    console.error(`[FATAL] Watchdog: ${reason} - saving state and restarting`);
    saveEverything();
    process.exit(1);
  },
});

function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] Received ${signal}, shutting down...`);
  watchdog.stop();
  saveEverything();
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  saveEverything();
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[ERROR] Unhandled rejection:', reason);
});

async function runProcessing(job, replyTo) {
  try {
    await processSession(job);
    if (replyTo) await replyTo.reply('Готово: сводка и расшифровка в Telegram.').catch(() => {});
  } catch (err) {
    console.error(`[Pipeline] ${job.sessionId} failed:`, err);
    await sendTelegramText(`❌ Не получилось обработать запись от ${escapeHtml(formatMoscowTime(job.startTime))}: ${escapeHtml(err.message)}`);
    if (replyTo) await replyTo.reply(`Ошибка при обработке: ${err.message}`).catch(() => {});
  }
}

client.once(Events.ClientReady, () => {
  console.log('='.repeat(50));
  console.log(`Discord Secretary Bot v${VERSION}`);
  console.log(`Logged in as ${client.user.tag}`);
  console.log('='.repeat(50));

  const disk = recoveryService.checkDiskSpace();
  if (disk) {
    console.log(`[Startup] Disk: ${disk.available} free (${disk.usePercent}% used)`);
    if (disk.usePercent > 90) console.warn('[WARNING] Disk space low!');
  }

  // Meetings cut off by a crash/restart still get a transcript.
  for (const job of recoveryService.runRecovery()) enqueue(() => runProcessing(job, null));

  watchdog.start();
  console.log('[Startup] Bot ready for commands');
});

const HELP = `Discord Secretary v${VERSION}

**Команды:**
!join — начать запись голосового канала, в котором ты сейчас
!leave — остановить запись; сводка и расшифровка придут в Telegram
!audio — прислать в Telegram запись последнего созвона одним файлом (!audio 2 — предпоследнего)
!recordings — записи за последние 7 дней
!status — что сейчас делает бот

Расшифровка делается на нашем сервере (Whisper), без внешних сервисов. Сводку пишет Claude.`;

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.content.startsWith('!')) return;
  const args = message.content.slice(1).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  if (command === 'join') {
    const voiceChannel = message.member?.voice.channel;
    if (!voiceChannel) return message.reply('Сначала зайди в голосовой канал.');
    if (activeRecording) return message.reply('Уже идёт запись. Останови её командой !leave.');

    console.log(`[Command] !join - ${voiceChannel.name}`);
    const recorder = new AudioRecorder(sessionManager, recordingsDir);
    activeRecording = recorder;
    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
      });
      await recorder.start(connection, voiceChannel);
      const participants = voiceChannel.members.filter((m) => !m.user.bot).map((m) => m.displayName || m.user.username);
      await notifyRecordingStart(voiceChannel.name, participants);
      await message.reply(`Записываю «${voiceChannel.name}». Остановить — !leave.`);
    } catch (err) {
      console.error('[Command] !join error:', err);
      activeRecording = null;
      if (recorder.session) {
        sessionManager.release(recorder.session.id);
        updateSessionFile(recorder.session.dir, { state: 'failed', error: err.message });
      }
      await message.reply(`Не получилось подключиться: ${err.message}`);
    }
    return;
  }

  if (command === 'leave') {
    if (!activeRecording) return message.reply('Сейчас ничего не записывается.');
    console.log('[Command] !leave');
    const recorder = activeRecording;
    activeRecording = null;

    try {
      const info = recorder.getSessionInfo();
      const result = await recorder.stop();
      sessionManager.release(result.sessionId);
      if (result.users.length === 0) {
        updateSessionFile(result.sessionDir, { state: 'failed', error: 'nobody spoke' });
        return message.reply('Остановил. Никто ничего не сказал — расшифровывать нечего.');
      }
      await message.reply(`Остановил (${info.durationMin} мин, говорили: ${result.users.length}). Сводка и расшифровка придут в Telegram.`);
      const progressMessageId = await notifyRecordingEnd({ durationMin: info.durationMin, speakerCount: result.users.length });
      enqueue(() => runProcessing({ ...result, progressMessageId }, message));
    } catch (err) {
      console.error('[Command] !leave error:', err);
      await message.reply(`Ошибка при остановке: ${err.message}`);
    }
    return;
  }

  if (command === 'recordings') {
    const sessions = listProcessedSessions(recordingsDir).slice(0, 10);
    if (sessions.length === 0) return message.reply('Записей за последние 7 дней нет.');
    const lines = sessions.map((s, i) => `${i + 1}. ${formatMoscowTime(s.startTime)} — ${formatDuration(s.durationSec || 0)} — ${(s.speakers || []).join(', ')}`);
    return message.reply(`Записи (номер — для !audio):\n${lines.join('\n')}`);
  }

  if (command === 'audio') {
    const n = parseInt(args[0] || '1', 10);
    const session = listProcessedSessions(recordingsDir)[n - 1];
    if (!session) return message.reply('Такой записи нет. Список — !recordings');
    await message.reply(`Собираю запись созвона ${formatMoscowTime(session.startTime)}, пришлю в Telegram.`);
    busyJobs++;
    try {
      const files = await buildMixedAudio(session);
      await sendAudioFiles(files, `Созвон ${formatMoscowTime(session.startTime)}`);
      await message.reply('Отправил запись в Telegram.');
    } catch (err) {
      console.error('[Command] !audio error:', err);
      await message.reply(`Не получилось собрать запись: ${err.message}`);
    } finally {
      busyJobs--;
    }
    return;
  }

  if (command === 'status') {
    const health = watchdog.getStatus();
    let status = `Discord Secretary v${VERSION}\n\n**Запись:** ${activeRecording ? 'идёт' : 'нет'}`;
    if (activeRecording) {
      const info = activeRecording.getSessionInfo();
      status += `\n  Длительность: ${info.durationMin} мин\n  Говорили: ${info.speakerCount}`;
    }
    status += `\n**Обработка:** ${busyJobs > 0 ? `в очереди ${busyJobs}` : 'нет'}`;
    status += `\n\n**Здоровье:** работает ${Math.round(health.uptime / 60)} мин, память ${health.heapUsedMB} MB`;
    return message.reply(status);
  }

  if (command === 'help') return message.reply(HELP);
});

// A failed login (e.g. Discord's daily limit on new sessions, which the old
// restart loop used up) waits before exiting, so systemd's restart can't
// turn into hundreds of logins a day.
client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error(`[FATAL] Discord login failed: ${err.message}. Retrying in ${LOGIN_RETRY_DELAY_MS / 60_000} min.`);
  setTimeout(() => process.exit(1), LOGIN_RETRY_DELAY_MS);
});
