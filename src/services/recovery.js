/**
 * RecoveryService - sessions cut off by a crash or restart.
 *
 * On startup: every session still "recording"/"processing" on disk is either
 * handed back for processing (it has audio -- the meeting gets a transcript
 * marked as interrupted) or marked failed (no audio). Its state is saved, so
 * it isn't found again on the next start (the old version never saved it and
 * "recovered" the same 8 empty sessions on every restart).
 *
 * A session whose processing was already started twice is not retried
 * automatically: on 2026-10-21 an OOM-killed Whisper restarted the bot, and
 * recovery ran the same out-of-memory job again. !retry runs it by hand.
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { listChunkFiles } from '../recorder/chunk-writer.js';
import { updateSessionFile } from '../recorder/session-manager.js';

const MAX_AUTO_ATTEMPTS = 2;

/** Users of a session that still have audio chunks on disk. */
function usersWithAudio(sessionDir) {
  const chunksDir = path.join(sessionDir, 'chunks');
  if (!existsSync(chunksDir)) return [];
  return readdirSync(chunksDir).filter((id) => listChunkFiles(path.join(chunksDir, id)).length > 0
    || readdirSync(path.join(chunksDir, id)).some((f) => f.endsWith('.recording')));
}

/**
 * A processSession() job for a session on disk, or null if it has no audio
 * left. Used by recovery and by !retry.
 */
export function buildJobFromSession(session) {
  const userIds = usersWithAudio(session.dir);
  if (userIds.length === 0) return null;

  const chunksDir = path.join(session.dir, 'chunks');
  // Without a clean end time, the last write to a chunk is when it stopped.
  const lastWrite = Math.max(...userIds.flatMap((id) => readdirSync(path.join(chunksDir, id))
    .map((f) => statSync(path.join(chunksDir, id, f)).mtimeMs)));
  const endTime = session.endTime || session.emergencyShutdown || lastWrite;
  return {
    sessionId: session.id,
    sessionDir: session.dir,
    startTime: session.startTime,
    endTime: Math.max(endTime, session.startTime + 1000),
    users: userIds.map((userId) => ({ userId, name: session.participants?.[userId]?.userName || `User_${userId}` })),
    participants: Object.values(session.participants || {}).map((p) => p.userName),
    // !leave writes endTime; a recording cut off by a crash has none.
    interrupted: !session.endTime || Boolean(session.interrupted),
  };
}

export class RecoveryService {
  constructor(recordingsDir, sessionManager) {
    this.recordingsDir = recordingsDir;
    this.sessionManager = sessionManager;
  }

  /**
   * Returns { toProcess: jobs for processSession(), gaveUp: sessions not retried }.
   */
  runRecovery() {
    console.log('[Recovery] Scanning for incomplete sessions...');
    const toProcess = [];
    const gaveUp = [];

    for (const session of this.sessionManager.findRecoverableSessions()) {
      const job = buildJobFromSession(session);
      if (!job) {
        updateSessionFile(session.dir, { state: 'failed', error: 'recording cut off before any audio' });
        console.log(`[Recovery] ${session.id}: no audio, marked failed`);
        continue;
      }
      if ((session.processingAttempts || 0) >= MAX_AUTO_ATTEMPTS) {
        updateSessionFile(session.dir, { state: 'failed', error: `processing was interrupted ${session.processingAttempts} times` });
        console.log(`[Recovery] ${session.id}: processing already interrupted ${session.processingAttempts} times, not retrying`);
        gaveUp.push(session);
        continue;
      }
      toProcess.push(job);
      console.log(`[Recovery] ${session.id}: ${job.users.length} speaker(s) with audio, will process`);
    }

    if (toProcess.length === 0 && gaveUp.length === 0) console.log('[Recovery] Nothing to recover');
    return { toProcess, gaveUp };
  }

  checkDiskSpace() {
    try {
      const parts = execSync(`df -h "${this.recordingsDir}" | tail -1`).toString().trim().split(/\s+/);
      return { total: parts[1], used: parts[2], available: parts[3], usePercent: parseInt(parts[4]) };
    } catch {
      return null;
    }
  }
}
