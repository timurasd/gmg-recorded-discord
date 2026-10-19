/**
 * RecoveryService - sessions cut off by a crash or restart.
 *
 * On startup: every session still "recording"/"processing" on disk is either
 * handed back for processing (it has audio -- the meeting gets a transcript
 * marked as interrupted) or marked failed (no audio). Its state is saved, so
 * it isn't found again on the next start (the old version never saved it and
 * "recovered" the same 8 empty sessions on every restart).
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { listChunkFiles } from '../recorder/chunk-writer.js';
import { updateSessionFile } from '../recorder/session-manager.js';

export class RecoveryService {
  constructor(recordingsDir, sessionManager) {
    this.recordingsDir = recordingsDir;
    this.sessionManager = sessionManager;
  }

  /**
   * Returns sessions with audio, ready for processSession().
   */
  runRecovery() {
    console.log('[Recovery] Scanning for incomplete sessions...');
    const toProcess = [];

    for (const session of this.sessionManager.findRecoverableSessions()) {
      const chunksDir = path.join(session.dir, 'chunks');
      const userIds = existsSync(chunksDir)
        ? readdirSync(chunksDir).filter((id) => listChunkFiles(path.join(chunksDir, id)).length > 0
          || readdirSync(path.join(chunksDir, id)).some((f) => f.endsWith('.recording')))
        : [];

      if (userIds.length === 0) {
        updateSessionFile(session.dir, { state: 'failed', error: 'recording cut off before any audio' });
        console.log(`[Recovery] ${session.id}: no audio, marked failed`);
        continue;
      }

      // Without a clean shutdown time, the last write to a chunk is when it stopped.
      const lastWrite = Math.max(...userIds.flatMap((id) => readdirSync(path.join(chunksDir, id))
        .map((f) => statSync(path.join(chunksDir, id, f)).mtimeMs)));
      const endTime = session.endTime || session.emergencyShutdown || lastWrite;
      toProcess.push({
        sessionId: session.id,
        sessionDir: session.dir,
        startTime: session.startTime,
        endTime: Math.max(endTime, session.startTime + 1000),
        users: userIds.map((userId) => ({ userId, name: session.participants?.[userId]?.userName || `User_${userId}` })),
        participants: Object.values(session.participants || {}).map((p) => p.userName),
        interrupted: true,
      });
      console.log(`[Recovery] ${session.id}: ${userIds.length} speaker(s) with audio, will process`);
    }

    if (toProcess.length === 0) console.log('[Recovery] Nothing to recover');
    return toProcess;
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
