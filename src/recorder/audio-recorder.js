/**
 * AudioRecorder - Orchestrates reliable audio recording
 * 
 * Main features:
 * - Chunked recording with atomic writes
 * - Per-user audio streams
 * - Automatic chunk rotation
 * - Crash recovery support
 * - Progress tracking
 */

import { VoiceConnectionStatus, entersState, EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import { ChunkWriter } from './chunk-writer.js';
import { SessionManager, SESSION_STATES } from './session-manager.js';
import { transcribeSession } from '../transcribe.js';
import { summarizeTranscript } from '../summarize.js';
import { updateProgress, notifyRecordingEnd } from '../delivery.js';

const HEALTH_CHECK_INTERVAL = 10000; // 10 sec
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
    this.isRecording = false;
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

    // Create session
    this.session = this.sessionManager.createSession(
      voiceChannel.id,
      voiceChannel.name,
      voiceChannel.guild.id
    );

    // Collect initial participants
    voiceChannel.members.forEach(member => {
      if (!member.user.bot) {
        this.userNames.set(member.id, member.displayName || member.user.username);
        this.sessionManager.addParticipant(this.session.id, member.id, member.displayName);
      }
    });

    // Setup connection handlers
    this._setupConnectionHandlers();

    // Wait for connection to be ready
    console.log('[AudioRecorder] Waiting for connection...');
    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
    console.log('[AudioRecorder] Connection ready!');

    // Setup audio receiver
    this.receiver = connection.receiver;
    this._setupSpeakingHandlers();

    // Start health monitoring
    this._startHealthCheck();

    console.log(`[AudioRecorder] Started recording session ${this.session.id}`);
    return this.session;
  }

  /**
   * Setup connection state handlers
   */
  _setupConnectionHandlers() {
    this.connection.on('stateChange', (oldState, newState) => {
      console.log(`[AudioRecorder] Connection: ${oldState.status} -> ${newState.status}`);
      
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        // Try to reconnect
        Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5000),
        ]).catch(() => {
          // Truly disconnected - save what we have
          console.log('[AudioRecorder] Connection lost, emergency saving...');
          this._emergencySave();
        });
      }
    });

    this.connection.on('error', (error) => {
      console.error('[AudioRecorder] Connection error:', error);
    });
  }

  /**
   * Setup audio speaking event handlers
   */
  _setupSpeakingHandlers() {
    this.receiver.speaking.on('start', (userId) => {
      this.lastAudioTime = Date.now();
      
      // Get or create chunk writer for this user
      let writer = this.chunkWriters.get(userId);
      if (!writer) {
        writer = new ChunkWriter(this.session.dir, userId);
        this.chunkWriters.set(userId, writer);
      }

      // Update session with participant
      const userName = this.userNames.get(userId) || `User_${userId}`;
      this.sessionManager.addParticipant(this.session.id, userId, userName);

      // Subscribe to user's audio
      const opusStream = this.receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 1000,
        },
      });

      // Decode Opus -> PCM
      const opusDecoder = new prism.opus.Decoder({
        frameSize: 960,
        channels: 2,
        rate: 48000,
      });

      // Write decoded audio to chunks
      opusDecoder.on('data', (chunk) => {
        if (this.isRecording) {
          writer.write(chunk);
        }
      });

      opusStream.on('error', (err) => {
        console.error(`[AudioRecorder] Stream error for ${userId}:`, err.message);
      });

      opusDecoder.on('error', (err) => {
        console.error(`[AudioRecorder] Decoder error for ${userId}:`, err.message);
      });

      opusStream.pipe(opusDecoder);
      
      console.log(`[AudioRecorder] 🎤 User ${userName} started speaking`);
    });

    this.receiver.speaking.on('end', (userId) => {
      const userName = this.userNames.get(userId) || userId;
      console.log(`[AudioRecorder] 🔇 User ${userName} stopped speaking`);
      
      // Sync current chunk to disk
      const writer = this.chunkWriters.get(userId);
      if (writer) {
        writer.sync();
      }
    });
  }

  /**
   * Start health monitoring
   */
  _startHealthCheck() {
    this.healthCheckInterval = setInterval(() => {
      const stats = this.getStats();
      const timeSinceLastAudio = Date.now() - this.lastAudioTime;
      
      // Log stats
      console.log(`[AudioRecorder] Health: ${stats.durationMin}min, ${stats.speakerCount} speakers, ${(stats.totalBytes / 1024 / 1024).toFixed(2)}MB`);
      
      // Warning if no audio for a while
      if (timeSinceLastAudio > INACTIVITY_WARNING_MS) {
        console.warn(`[AudioRecorder] ⚠️ No audio for ${Math.round(timeSinceLastAudio / 60000)} minutes`);
      }

      // Sync all writers
      for (const writer of this.chunkWriters.values()) {
        writer.sync();
      }
    }, HEALTH_CHECK_INTERVAL);
  }

  /**
   * Get current recording stats
   */
  getStats() {
    let totalBytes = 0;
    let chunksCount = 0;

    for (const writer of this.chunkWriters.values()) {
      const stats = writer.getStats();
      totalBytes += stats.totalBytes;
      chunksCount += stats.chunksCompleted;
    }

    return {
      sessionId: this.session?.id,
      durationMin: Math.round((Date.now() - this.startTime) / 60000),
      speakerCount: this.chunkWriters.size,
      totalBytes,
      chunksCount,
      isRecording: this.isRecording,
      participants: Array.from(this.userNames.values())
    };
  }

  /**
   * Stop recording and process
   */
  async stop() {
    if (!this.isRecording) {
      throw new Error('Not recording');
    }

    console.log('[AudioRecorder] Stopping recording...');
    this.isRecording = false;

    // Stop health check
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Close all chunk writers
    const userFiles = [];
    for (const [userId, writer] of this.chunkWriters.entries()) {
      writer.close();
      
      // Concatenate chunks into single PCM
      const pcmPath = `${this.session.dir}/${userId}.pcm`;
      try {
        await writer.concatenateChunks(pcmPath);
        userFiles.push({
          userId,
          userName: this.userNames.get(userId) || `User_${userId}`,
          pcmFile: pcmPath,
          startOffset: 0
        });
      } catch (err) {
        console.error(`[AudioRecorder] Failed to concatenate chunks for ${userId}:`, err.message);
      }
    }

    // Disconnect from voice
    this.connection.destroy();

    // Update session state
    this.sessionManager.endSession(this.session.id);

    if (userFiles.length === 0) {
      this.sessionManager.failSession(this.session.id, new Error('No audio recorded'));
      throw new Error('Нет записанных аудиопотоков.');
    }

    const stats = this.getStats();
    console.log(`[AudioRecorder] Recording stopped: ${stats.durationMin}min, ${stats.speakerCount} speakers, ${(stats.totalBytes / 1024 / 1024).toFixed(2)}MB`);

    return {
      session: this.session,
      userFiles,
      stats
    };
  }

  /**
   * Process recording (transcribe + summarize)
   */
  async process(userFiles) {
    try {
      // Update progress: starting transcription
      await updateProgress(0, '', 'transcribing');

      console.log('[AudioRecorder] Starting transcription...');
      const transcript = await transcribeSession(userFiles, this.session.dir, async (progress, userName) => {
        await updateProgress(progress, userName, 'transcribing');
      });

      // Update progress: summarizing
      await updateProgress(90, '', 'summarizing');

      console.log('[AudioRecorder] Starting summarization...');
      const summary = await summarizeTranscript(transcript);

      // Update progress: done
      await updateProgress(100, '', 'done');

      // Mark session as complete
      this.sessionManager.completeSession(this.session.id, { transcript, summary });

      return {
        sessionDir: this.session.dir,
        transcript,
        summary,
        participants: Array.from(this.userNames.values()),
        durationSec: Math.round((Date.now() - this.startTime) / 1000),
      };
    } catch (err) {
      this.sessionManager.failSession(this.session.id, err);
      throw err;
    }
  }

  /**
   * Emergency save all data (called on crash)
   */
  _emergencySave() {
    console.log('[AudioRecorder] Emergency saving all chunks...');
    
    for (const writer of this.chunkWriters.values()) {
      writer.emergencySave();
    }
    
    if (this.session) {
      this.sessionManager.emergencySaveAll();
    }
  }

  /**
   * Get session info for progress messages
   */
  getSessionInfo() {
    const stats = this.getStats();
    return {
      durationMin: stats.durationMin,
      speakerCount: stats.speakerCount,
      totalSize: stats.totalBytes,
      estimatedMin: Math.ceil(Math.max(1, (stats.totalBytes / 1024 / 1024 / 6) * 0.5)),
      participants: stats.participants
    };
  }
}
