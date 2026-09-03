import 'dotenv/config';
import { Client, GatewayIntentBits, Events } from 'discord.js';
import { joinVoiceChannel } from '@discordjs/voice';
import { startRecording, stopRecording } from './recorder.js';
import { sendResults, notifyRecordingStart, notifyRecordingEnd } from './delivery.js';
import { ensureDir } from './utils.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

let activeRecording = null;

client.once(Events.ClientReady, () => {
  console.log(`Bot logged in as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;

  const prefix = '!';
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  if (command === 'join') {
    const member = message.member;
    if (!member || !member.voice.channel) {
      return message.reply('Сначала зайди в голосовой канал.');
    }

    const voiceChannel = member.voice.channel;
    
    console.log(`🔌 Joining voice channel: ${voiceChannel.name} (${voiceChannel.id})`);
    console.log(`🔐 Channel is E2E encrypted: ${voiceChannel.guild.features.includes('ENCRYPTED_VOICE_CHANNELS') ? 'YES' : 'NO'}`);
    
    const connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false, // Меняем на false чтобы слышать
      debug: true,
    });

    const recordingDir = await ensureDir(process.env.AUDIO_OUTPUT_DIR || './recordings');
    activeRecording = await startRecording(connection, voiceChannel, recordingDir);

    await notifyRecordingStart(voiceChannel);
    await message.reply(`Подключился к ${voiceChannel.name} и начал многоканальную запись.`);
  }

  if (command === 'leave') {
    if (!activeRecording) {
      return message.reply('Сейчас ничего не записывается.');
    }

    const session = activeRecording;
    activeRecording = null;

    await notifyRecordingEnd();
    await message.reply('Останавливаю запись и запускаю обработку. Это может занять несколько минут.');

    try {
      const result = await stopRecording(session);
      await sendResults(result);
      await message.reply('Сводка и расшифровка отправлены.');
    } catch (err) {
      console.error(err);
      await message.reply('Ошибка при обработке записи: ' + err.message);
    }
  }

  if (command === 'status') {
    if (activeRecording) {
      return message.reply('Запись активна.');
    }
    return message.reply('Запись не активна.');
  }
});

client.login(process.env.DISCORD_TOKEN);
