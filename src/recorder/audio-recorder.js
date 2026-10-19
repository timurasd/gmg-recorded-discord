/**
 * AudioRecorder - records a voice channel from !join to !leave.
 *
 * - One crash-safe chunk stream per user (ChunkWriter)
 * - A marker at the start of every utterance, so the processing step knows
 *   when each piece was said (see timeline.js)
 * - Any number of people; someone who joins later is picked up when they talk
 *
 * Processing (transcript, summary, delivery) lives in pipeline.js, so the same
 * code also handles a session recovered after a crash.
 */

import { VoiceConnectionStatus, entersState, EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import path from 'path';
import { ChunkWriter } from './chunk-writer.js';

const HEALTH_CHECK_INTERVAL = 10000; // sync chunks to disk every 10 sec
const HEALTH_LOG_INTERVAL = 60000;
const INACTIVITY_WARNING_MS = 300000; // 5 min without audio

export class AudioRecorder {
  constructor(sessionManager, recordingDir) {
    this.sessionManager = sessionManager;
    this.recordingDir = recordingDir;
    this.chunkWriters = new Map(); // userId -> ChunkWriter
    this.session = null;
    this.connection = null;
    this.voiceChannel = null;
    this.receiver = null;
    this.startTime = null;
    this.lastAudioTime = null;
    this.healthCheckInterval = null;
    this.lastHealthLog = 0;
    this.isRecording = false;
    this.disconnected = false;
    this.userNames = new Map();
  }

  /**
   * Start recording a voice channel
   */
  async start(connection, voiceChannel) {
    this.connection = connection;
    this.voiceChannel = voiceChannel;
    this.startTime = Date.now();
    this.lastAudioTime = Date.now();
    this.isRecording = true;

    this.session = this.sessionManager.createSession(voiceChannel.id, voiceChannel.name, voiceChannel.guild.id);

    voiceChannel.members.forEach(member => {
      if (!member.user.bot) this.userNames.set(member.id, member.displayName || member.user.username);
    });

    this._setupConnectionHandlers();

    console.log('[AudioRecorder] Waiting for connection...');
    await entersState(connection, VoiceConnectionStatus.Ready, 30000);
    console.log('[AudioRecorder] Connection ready!');

    this.receiver = connection.receiver;
    this._setupSpeakingHandlers();
    this._startHealthCheck();

    console.log(`[AudioRecorder] Started recording session ${this.session.id}`);
    return this.session;
  }

  _setupConnectionHandlers() {
    this.connection.on('stateChange', (oldState, newState) => {
      console.log(`[AudioRecorder] Connection: ${oldState.status} -> ${newState.status}`);
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
        ]).catch(() => {
          // Truly disconnected: keep what we have; !leave still processes it.
          console.log('[AudioRecorder] Connection lost, saving what was recorded');
          this.disconnected = true;
          this._emergencySave();
        });
      }
    });

    this.connection.on('error', (error) => {
      console.error('[AudioRecorder] Connection error:', error);
    });
  }

  /** Display name, also for someone who joined the channel after !join. */
  _nameFor(userId) {
    let name = this.userNames.get(userId);
    if (!name) {
      const member = this.voiceChannel?.guild.members.cache.get(userId);
      name = member?.displayName || member?.user?.username || `User_${userId}`;
      this.userNames.set(userId, name);
    }
    return name;
  }

  _setupSpeakingHandlers() {
    this.receiver.speaking.on('start', (userId) => {
      this.lastAudioTime = Date.now();
      if (!this.isRecording) return;

      // One subscription per utterance. While the previous one hasn't ended
      // (a pause under 1 s), subscribe() hands back the SAME stream -- the old
      // code piped it into a second decoder and wrote every frame twice.
      if (this.receiver.subscriptions.has(userId)) return;

      let writer = this.chunkWriters.get(userId);
      if (!writer) {
        writer = new ChunkWriter(this.session.dir, userId);
        this.chunkWriters.set(userId, writer);
      }
      const userName = this._nameFor(userId);
      this.sessionManager.addParticipant(this.session.id, userId, userName);

      const opusStream = this.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
      });
      const opusDecoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });

      let marked = false;
      opusDecoder.on('data', (chunk) => {
        if (!this.isRecording) return;
        if (!marked) {
          // When this utterance starts in the meeting, at the first sound.
          writer.mark(Date.now() - this.startTime);
          marked = true;
        }
        writer.write(chunk);
      });

      opusStream.on('error', (err) => {
        console.error(`[AudioRecorder] Stream error for ${userId}:`, err.message);
      });
      opusDecoder.on('error', (err) => {
        console.error(`[AudioRecorder] Decoder error for ${userId}:`, err.message);
      });

      opusStream.pipe(opusDecoder);
    });

    this.receiver.speaking.on('end', (userId) => {
      this.chunkWriters.get(userId)?.sync();
    });
  }

  _startHealthCheck() {
    this.healthCheckInterval = setInterval(() => {
      for (const writer of this.chunkWriters.values()) writer.sync();

      const now = Date.now();
      if (now - this.lastHealthLog >= HEALTH_LOG_INTERVAL) {
        this.lastHealthLog = now;
        const stats = this.getStats();
        console.log(`[AudioRecorder] Health: ${stats.durationMin}min, ${stats.speakerCount} speakers, ${(stats.totalBytes / 1024 / 1024).toFixed(2)}MB`);
        if (now - this.lastAudioTime > INACTIVITY_WARNING_MS) {
          console.warn(`[AudioRecorder] No audio for ${Math.round((now - this.lastAudioTime) / 60000)} minutes`);
        }
      }
    }, HEALTH_CHECK_INTERVAL);
  }

  getStats() {
    let totalBytes = 0;
    for (const writer of this.chunkWriters.values()) totalBytes += writer.getStats().totalBytes;
    return {
      sessionId: this.session?.id,
      durationMin: Math.round((Date.now() - this.startTime) / 60000),
      speakerCount: this.chunkWriters.size,
      totalBytes,
      isRecording: this.isRecording,
      participants: Array.from(this.userNames.values()),
    };
  }

  /**
   * Stop recording. Returns what the pipeline needs to process the session.
   */
  async stop() {
    if (!this.isRecording) throw new Error('Not recording');

    console.log('[AudioRecorder] Stopping recording...');
    this.isRecording = false;
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);

    for (const writer of this.chunkWriters.values()) writer.close();
    try {
      this.connection.destroy();
    } catch (err) {
      console.error('[AudioRecorder] Destroy error:', err.message);
    }
    this.sessionManager.endSession(this.session.id);

    const endTime = Date.now();
    const users = Array.from(this.chunkWriters.keys()).map(userId => ({
      userId,
      name: this._nameFor(userId),
      chunksDir: path.join(this.session.dir, 'chunks', userId),
    }));
    const stats = this.getStats();
    console.log(`[AudioRecorder] Recording stopped: ${stats.durationMin}min, ${users.length} speakers, ${(stats.totalBytes / 1024 / 1024).toFixed(2)}MB`);

    return {
      sessionId: this.session.id,
      sessionDir: this.session.dir,
      startTime: this.startTime,
      endTime,
      users,
      participants: Array.from(this.userNames.values()),
      interrupted: this.disconnected,
    };
  }

  _emergencySave() {
    console.log('[AudioRecorder] Emergency saving all chunks...');
    for (const writer of this.chunkWriters.values()) writer.emergencySave();
    if (this.session) this.sessionManager.emergencySaveAll();
  }

  getSessionInfo() {
    const stats = this.getStats();
    return {
      durationMin: stats.durationMin,
      speakerCount: stats.speakerCount,
      totalSize: stats.totalBytes,
      participants: stats.participants,
    };
  }
}
