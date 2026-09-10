/**
 * ChunkWriter - Atomic, crash-safe audio chunk writer
 * 
 * Writes audio data in discrete chunks with:
 * - Immediate disk sync (fdatasync every 5 sec)
 * - Atomic chunk finalization (rename pattern)
 * - Chunk state tracking (.recording -> .complete)
 * - Checksums for integrity verification
 */

import { openSync, writeSync, fdatasyncSync, closeSync, renameSync, statSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const CHUNK_DURATION_MS = 60000;  // 1-minute chunks
const SYNC_INTERVAL_MS = 5000;    // Sync every 5 seconds
const MAX_CHUNKS = 120;           // Max 2 hours of recording

export class ChunkWriter {
  constructor(sessionDir, userId) {
    this.sessionDir = sessionDir;
    this.userId = userId;
    this.chunksDir = path.join(sessionDir, 'chunks', userId);
    
    this.currentChunkIndex = 0;
    this.currentChunkFd = null;
    this.currentChunkPath = null;
    this.chunkStartTime = null;
    this.bytesWritten = 0;
    this.totalBytesWritten = 0;
    this.lastSyncTime = Date.now();
    this.hash = null;
    this.isActive = false;
    
    // Ensure chunks directory exists
    mkdirSync(this.chunksDir, { recursive: true });
    
    // Find existing chunks to continue numbering
    this._findLastChunkIndex();
  }

  _findLastChunkIndex() {
    try {
      const files = readdirSync(this.chunksDir);
      const indices = files
        .filter(f => f.endsWith('.complete') || f.endsWith('.recording'))
        .map(f => parseInt(f.match(/chunk_(\d+)/)?.[1] || '0'))
        .filter(n => !isNaN(n));
      
      if (indices.length > 0) {
        this.currentChunkIndex = Math.max(...indices) + 1;
        console.log(`[ChunkWriter] Resuming from chunk ${this.currentChunkIndex} for user ${this.userId}`);
      }
    } catch (err) {
      // Directory might not exist yet
    }
  }

  /**
   * Start a new chunk file
   */
  startNewChunk() {
    // Close previous chunk if any
    if (this.currentChunkFd !== null) {
      this._finalizeCurrentChunk();
    }

    if (this.currentChunkIndex >= MAX_CHUNKS) {
      console.warn(`[ChunkWriter] Max chunks reached for user ${this.userId}`);
      return false;
    }

    const chunkName = `chunk_${String(this.currentChunkIndex).padStart(4, '0')}.pcm.recording`;
    this.currentChunkPath = path.join(this.chunksDir, chunkName);
    
    this.currentChunkFd = openSync(this.currentChunkPath, 'w');
    this.chunkStartTime = Date.now();
    this.bytesWritten = 0;
    this.hash = crypto.createHash('sha256');
    this.isActive = true;
    
    console.log(`[ChunkWriter] Started chunk ${this.currentChunkIndex} for user ${this.userId}`);
    return true;
  }

  /**
   * Write audio data to current chunk
   */
  write(buffer) {
    if (!this.isActive || this.currentChunkFd === null) {
      if (!this.startNewChunk()) {
        return false;
      }
    }

    try {
      writeSync(this.currentChunkFd, buffer);
      this.hash.update(buffer);
      this.bytesWritten += buffer.length;
      this.totalBytesWritten += buffer.length;

      // Periodic sync to disk
      const now = Date.now();
      if (now - this.lastSyncTime >= SYNC_INTERVAL_MS) {
        fdatasyncSync(this.currentChunkFd);
        this.lastSyncTime = now;
      }

      // Rotate chunk if duration exceeded
      if (now - this.chunkStartTime >= CHUNK_DURATION_MS) {
        this._rotateChunk();
      }

      return true;
    } catch (err) {
      console.error(`[ChunkWriter] Write error for user ${this.userId}:`, err.message);
      return false;
    }
  }

  /**
   * Force sync current chunk to disk
   */
  sync() {
    if (this.currentChunkFd !== null) {
      try {
        fdatasyncSync(this.currentChunkFd);
        this.lastSyncTime = Date.now();
      } catch (err) {
        console.error(`[ChunkWriter] Sync error:`, err.message);
      }
    }
  }

  /**
   * Rotate to new chunk (finalize current, start new)
   */
  _rotateChunk() {
    this._finalizeCurrentChunk();
    this.currentChunkIndex++;
    this.startNewChunk();
  }

  /**
   * Finalize current chunk (sync, close, rename, write metadata)
   */
  _finalizeCurrentChunk() {
    if (this.currentChunkFd === null) return;

    try {
      // Final sync
      fdatasyncSync(this.currentChunkFd);
      closeSync(this.currentChunkFd);

      // Calculate checksum
      const checksum = this.hash.digest('hex');

      // Rename to .complete (atomic operation)
      const completePath = this.currentChunkPath.replace('.recording', '.complete');
      renameSync(this.currentChunkPath, completePath);

      // Write metadata file
      const metaPath = completePath + '.meta';
      const metadata = JSON.stringify({
        userId: this.userId,
        chunkIndex: this.currentChunkIndex,
        bytes: this.bytesWritten,
        checksum,
        startTime: this.chunkStartTime,
        endTime: Date.now(),
        durationMs: Date.now() - this.chunkStartTime
      }, null, 2);
      
      const metaFd = openSync(metaPath, 'w');
      writeSync(metaFd, metadata);
      fdatasyncSync(metaFd);
      closeSync(metaFd);

      console.log(`[ChunkWriter] Finalized chunk ${this.currentChunkIndex} for user ${this.userId} (${(this.bytesWritten / 1024).toFixed(1)} KB, checksum: ${checksum.slice(0, 8)}...)`);
    } catch (err) {
      console.error(`[ChunkWriter] Finalize error:`, err.message);
    }

    this.currentChunkFd = null;
    this.currentChunkPath = null;
    this.hash = null;
  }

  /**
   * Close writer (finalize current chunk)
   */
  close() {
    this.isActive = false;
    this._finalizeCurrentChunk();
    console.log(`[ChunkWriter] Closed for user ${this.userId}, total: ${(this.totalBytesWritten / 1024 / 1024).toFixed(2)} MB`);
  }

  /**
   * Emergency save - called on crash/shutdown
   */
  emergencySave() {
    if (this.currentChunkFd !== null) {
      try {
        fdatasyncSync(this.currentChunkFd);
        closeSync(this.currentChunkFd);
        console.log(`[ChunkWriter] Emergency save for user ${this.userId}`);
      } catch (err) {
        console.error(`[ChunkWriter] Emergency save failed:`, err.message);
      }
      this.currentChunkFd = null;
    }
  }

  /**
   * Get all completed chunk paths for this user
   */
  getCompletedChunks() {
    try {
      const files = readdirSync(this.chunksDir);
      return files
        .filter(f => f.endsWith('.complete'))
        .sort()
        .map(f => path.join(this.chunksDir, f));
    } catch (err) {
      return [];
    }
  }

  /**
   * Get recording stats
   */
  getStats() {
    return {
      userId: this.userId,
      chunksCompleted: this.currentChunkIndex,
      currentChunkBytes: this.bytesWritten,
      totalBytes: this.totalBytesWritten,
      isActive: this.isActive,
      recordingDurationMs: this.chunkStartTime ? Date.now() - this.chunkStartTime : 0
    };
  }

  /**
   * Concatenate all chunks into single PCM file
   */
  async concatenateChunks(outputPath) {
    const chunks = this.getCompletedChunks();
    if (chunks.length === 0) {
      throw new Error('No completed chunks to concatenate');
    }

    const outputFd = openSync(outputPath, 'w');
    let totalBytes = 0;

    for (const chunkPath of chunks) {
      const data = await fs.readFile(chunkPath);
      writeSync(outputFd, data);
      totalBytes += data.length;
    }

    fdatasyncSync(outputFd);
    closeSync(outputFd);

    console.log(`[ChunkWriter] Concatenated ${chunks.length} chunks into ${outputPath} (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`);
    return totalBytes;
  }
}

/**
 * Recover incomplete chunks from a session directory
 */
export async function recoverIncompleteChunks(sessionDir) {
  const recovered = [];
  const chunksBaseDir = path.join(sessionDir, 'chunks');
  
  if (!existsSync(chunksBaseDir)) {
    return recovered;
  }

  const userDirs = readdirSync(chunksBaseDir);
  
  for (const userId of userDirs) {
    const userChunksDir = path.join(chunksBaseDir, userId);
    const files = readdirSync(userChunksDir);
    
    for (const file of files) {
      if (file.endsWith('.recording')) {
        const recordingPath = path.join(userChunksDir, file);
        const completePath = recordingPath.replace('.recording', '.partial');
        
        try {
          // Rename incomplete chunk to .partial (so we know it's incomplete)
          renameSync(recordingPath, completePath);
          recovered.push({ userId, path: completePath, status: 'partial' });
          console.log(`[Recovery] Marked incomplete chunk as partial: ${file}`);
        } catch (err) {
          console.error(`[Recovery] Failed to recover ${file}:`, err.message);
        }
      }
    }
  }

  return recovered;
}
