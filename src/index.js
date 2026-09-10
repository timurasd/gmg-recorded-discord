import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { joinVoiceChannel } from '@discordjs/voice';
import { SessionManager } from './recorder/session-manager.js';
import { AudioRecorder } from './recorder/audio-recorder.js';
import { BackupService } from './services/backup.js';
import { RecoveryService } from './services/recovery.js';
import { Watchdog } from './services/watchdog.js';
import { sendResults, notifyRecordingStart, notifyRecordingEnd } from './delivery.js';
import { ensureDir } from './utils.js';

const VERSION = '2.0.0';

// Initialize services
const recordingsDir = process.env.AUDIO_OUTPUT_DIR || './recordings';
const backupsDir = './backups';

await ensureDir(recordingsDir);
await ensureDir(backupsDir);

const sessionManager = new SessionManager(recordingsDir);
const backupService = new BackupService(recordingsDir, backupsDir);
const recoveryService = new RecoveryService(recordingsDir, sessionManager);

// Initialize watchdog
const watchdog = new Watchdog({
  timeout: 120000,  // 2 minutes
  onTimeout: async function() {
    console.error('[FATAL] Watchdog timeout - saving state and restarting...');
    if (activeRecording) {
      activeRecording._emergencySave();
    }
    sessionManager.emergencySaveAll();
    process.exit(1);
  }
});

// Active recording state
let activeRecording = null;

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// Graceful shutdown handler
async function gracefulShutdown(signal) {
  console.log('\n[Shutdown] Received ' + signal + ', shutting down gracefully...');
  
  watchdog.stop();
  
  // Save active recording
  if (activeRecording) {
    console.log('[Shutdown] Saving active recording...');
    activeRecording._emergencySave();
    sessionManager.emergencySaveAll();
  }
  
  // Destroy Discord client
  client.destroy();
  
  console.log('[Shutdown] Cleanup complete, exiting');
  process.exit(0);
}

// Register signal handlers
process.on('SIGINT', function() { gracefulShutdown('SIGINT'); });
process.on('SIGTERM', function() { gracefulShutdown('SIGTERM'); });
process.on('uncaughtException', function(err) {
  console.error('[FATAL] Uncaught exception:', err);
  if (activeRecording) {
    activeRecording._emergencySave();
  }
  sessionManager.emergencySaveAll();
  process.exit(1);
});
process.on('unhandledRejection', function(reason, promise) {
  console.error('[FATAL] Unhandled rejection at:', promise, 'reason:', reason);
});

// Discord ready handler
client.once(Events.ClientReady, async function() {
  console.log('='.repeat(50));
  console.log('Discord Secretary Bot v' + VERSION);
  console.log('Logged in as ' + client.user.tag);
  console.log('='.repeat(50));
  
  // Run recovery check
  const recovered = await recoveryService.runRecovery();
  if (recovered.length > 0) {
    console.log('[Startup] Recovered ' + recovered.length + ' incomplete session(s)');
  }
  
  // Check disk space
  const diskSpace = recoveryService.checkDiskSpace();
  if (diskSpace) {
    console.log('[Startup] Disk space: ' + diskSpace.available + ' available (' + diskSpace.usePercent + '% used)');
    if (diskSpace.usePercent > 90) {
      console.warn('[WARNING] Disk space low! Consider cleanup.');
    }
  }
  
  // Start watchdog
  watchdog.start();
  
  // Signal PM2 ready
  if (process.send) {
    process.send('ready');
  }
  
  console.log('[Startup] Bot ready for commands');
});

// Message handler
client.on(Events.MessageCreate, async function(message) {
  if (message.author.bot) return;
  
  // Kick watchdog on any activity
  watchdog.kick();

  const prefix = '!';
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  // !join - Start recording
  if (command === 'join') {
    const member = message.member;
    if (!member || !member.voice.channel) {
      return message.reply('Сначала зайди в голосовой канал.');
    }

    if (activeRecording) {
      return message.reply('Уже идёт запись. Используй !leave чтобы остановить.');
    }

    const voiceChannel = member.voice.channel;
    
    console.log('[Command] !join - Channel: ' + voiceChannel.name);
    
    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
      });

      activeRecording = new AudioRecorder(sessionManager, recordingsDir);
      const session = await activeRecording.start(connection, voiceChannel);

      // Get participant names
      const participants = voiceChannel.members
        .filter(function(m) { return !m.user.bot; })
        .map(function(m) { return m.displayName || m.user.username; });

      await notifyRecordingStart(voiceChannel, participants);
      await message.reply('Подключился к ' + voiceChannel.name + ' и начал надёжную многоканальную запись v' + VERSION + '.');
      
    } catch (err) {
      console.error('[Command] !join error:', err);
      activeRecording = null;
      await message.reply('Ошибка подключения: ' + err.message);
    }
  }

  // !leave - Stop recording
  if (command === 'leave') {
    if (!activeRecording) {
      return message.reply('Сейчас ничего не записывается.');
    }

    console.log('[Command] !leave');
    
    const recorder = activeRecording;
    activeRecording = null;

    try {
      // Get session info before stopping
      const sessionInfo = recorder.getSessionInfo();
      
      await notifyRecordingEnd(sessionInfo);
      await message.reply('Останавливаю запись (' + sessionInfo.durationMin + ' мин, ' + sessionInfo.speakerCount + ' спикеров). Обработка займёт ~' + sessionInfo.estimatedMin + ' мин.');

      // Stop and get files
      const { userFiles, stats } = await recorder.stop();
      
      // Process (transcribe + summarize)
      const result = await recorder.process(userFiles);
      
      // Archive session
      backupService.archiveSession(recorder.session.dir);
      
      // Send results
      await sendResults(result);
      await message.reply('Сводка и расшифровка отправлены!');
      
    } catch (err) {
      console.error('[Command] !leave error:', err);
      await message.reply('Ошибка при обработке: ' + err.message);
    }
  }

  // !status - Show status
  if (command === 'status') {
    watchdog.kick();
    
    const health = watchdog.getStatus();
    const backupStats = backupService.getStats();
    
    let status = 'Discord Secretary v' + VERSION + '\n';
    status += '\n**Запись:** ' + (activeRecording ? 'Активна' : 'Нет');
    
    if (activeRecording) {
      const info = activeRecording.getSessionInfo();
      status += '\n  Длительность: ' + info.durationMin + ' мин';
      status += '\n  Спикеров: ' + info.speakerCount;
      status += '\n  Размер: ' + (info.totalSize / 1024 / 1024).toFixed(2) + ' MB';
    }
    
    status += '\n\n**Здоровье:**';
    status += '\n  Uptime: ' + Math.round(health.uptime / 60) + ' мин';
    status += '\n  Memory: ' + health.heapUsedMB + ' MB / ' + health.heapTotalMB + ' MB';
    
    status += '\n\n**Бэкапы:** ' + backupStats.count + ' архивов (' + backupStats.totalSizeMB + ' MB)';
    
    return message.reply(status);
  }

  // !help - Show help
  if (command === 'help') {
    const help = 'Discord Secretary v' + VERSION + '\n\n'
      + '**Команды:**\n'
      + '!join - Начать запись в текущем голосовом канале\n'
      + '!leave - Остановить запись и получить расшифровку\n'
      + '!status - Показать статус бота и записи\n'
      + '!help - Показать эту справку\n\n'
      + '**Особенности v2.0:**\n'
      + '- Надёжная chunked-запись (не теряет данные при крашах)\n'
      + '- Автоматическое архивирование сессий\n'
      + '- Восстановление после сбоев\n'
      + '- Мониторинг здоровья';
      
    return message.reply(help);
  }
});

// Login
client.login(process.env.DISCORD_TOKEN);
