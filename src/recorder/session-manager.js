/**
 * SessionManager - Persistent session state management
 * 
 * Tracks all recording sessions with:
 * - Atomic state persistence (write-ahead pattern)
 * - Auto-recovery on startup
 * - Session metadata (participants, timestamps, status)
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync, readFileSync, renameSync, unlinkSync } from 'fs';
import path from 'path';

const SESSION_STATES = {
  RECORDING: 'recording',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  RECOVERED: 'recovered'
};

export class SessionManager {
  constructor(baseDir) {
    this.baseDir = baseDir;
    this.activeSessions = new Map();
    
    mkdirSync(baseDir, { recursive: true });
  }

  /**
   * Create a new recording session
   */
  createSession(channelId, channelName, guildId) {
    const sessionId = `session_${Date.now()}`;
    const sessionDir = path.join(this.baseDir, sessionId);
    
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(path.join(sessionDir, 'chunks'), { recursive: true });

    const session = {
      id: sessionId,
      dir: sessionDir,
      channelId,
      channelName,
      guildId,
      state: SESSION_STATES.RECORDING,
      startTime: Date.now(),
      endTime: null,
      participants: {},
      error: null,
      version: 2  // Schema version for future migrations
    };

    this._saveSessionState(session);
    this.activeSessions.set(sessionId, session);
    
    console.log(`[SessionManager] Created session ${sessionId} for channel ${channelName}`);
    return session;
  }

  /**
   * Add or update participant in session
   */
  addParticipant(sessionId, userId, userName) {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      console.warn(`[SessionManager] Session ${sessionId} not found`);
      return;
    }

    if (!session.participants[userId]) {
      session.participants[userId] = {
        userId,
        userName,
        joinedAt: Date.now(),
        leftAt: null,
        speakingSegments: 0
      };
    }
    
    session.participants[userId].speakingSegments++;
    this._saveSessionState(session);
  }

  /**
   * Mark participant as left
   */
  participantLeft(sessionId, userId) {
    const session = this.activeSessions.get(sessionId);
    if (!session || !session.participants[userId]) return;
    
    session.participants[userId].leftAt = Date.now();
    this._saveSessionState(session);
  }

  /**
   * Update session state
   */
  updateState(sessionId, state, error = null) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    session.state = state;
    if (error) session.error = error;
    if (state === SESSION_STATES.COMPLETED || state === SESSION_STATES.FAILED) {
      session.endTime = Date.now();
    }
    
    this._saveSessionState(session);
    console.log(`[SessionManager] Session ${sessionId} state -> ${state}`);
  }

  /**
   * Get active session
   */
  getSession(sessionId) {
    return this.activeSessions.get(sessionId);
  }

  /**
   * End session
   */
  endSession(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return null;

    session.state = SESSION_STATES.PROCESSING;
    session.endTime = Date.now();
    this._saveSessionState(session);
    
    return session;
  }

  /**
   * Complete session
   */
  completeSession(sessionId, result = {}) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    session.state = SESSION_STATES.COMPLETED;
    session.result = result;
    this._saveSessionState(session);
    this.activeSessions.delete(sessionId);
  }

  /**
   * Fail session
   */
  failSession(sessionId, error) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    session.state = SESSION_STATES.FAILED;
    session.error = error.message || String(error);
    this._saveSessionState(session);
    this.activeSessions.delete(sessionId);
  }

  /**
   * Save session state atomically
   */
  _saveSessionState(session) {
    const statePath = path.join(session.dir, 'session.json');
    const tempPath = statePath + '.tmp';
    
    try {
      writeFileSync(tempPath, JSON.stringify(session, null, 2));
      renameSync(tempPath, statePath);
    } catch (err) {
      console.error(`[SessionManager] Failed to save state:`, err.message);
    }
  }

  /**
   * Load session state from disk
   */
  _loadSessionState(sessionDir) {
    const statePath = path.join(sessionDir, 'session.json');
    
    if (!existsSync(statePath)) {
      return null;
    }
    
    try {
      const data = readFileSync(statePath, 'utf-8');
      return JSON.parse(data);
    } catch (err) {
      console.error(`[SessionManager] Failed to load state from ${sessionDir}:`, err.message);
      return null;
    }
  }

  /**
   * Find all sessions that need recovery (were recording/processing when crashed)
   */
  findRecoverableSessions() {
    const recoverable = [];
    
    try {
      const entries = readdirSync(this.baseDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('session_')) {
          continue;
        }
        
        const sessionDir = path.join(this.baseDir, entry.name);
        const session = this._loadSessionState(sessionDir);
        
        if (session && (session.state === SESSION_STATES.RECORDING || session.state === SESSION_STATES.PROCESSING)) {
          recoverable.push(session);
        }
      }
    } catch (err) {
      console.error(`[SessionManager] Error scanning for recoverable sessions:`, err.message);
    }
    
    return recoverable;
  }

  /**
   * Get session duration in minutes
   */
  getSessionDuration(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return 0;
    
    const endTime = session.endTime || Date.now();
    return Math.round((endTime - session.startTime) / 60000);
  }

  /**
   * Get session info for status messages
   */
  getSessionInfo(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return null;

    return {
      durationMin: this.getSessionDuration(sessionId),
      speakerCount: Object.keys(session.participants).length,
      participants: Object.values(session.participants).map(p => p.userName),
      state: session.state,
      channelName: session.channelName
    };
  }

  /**
   * Emergency save all active sessions
   */
  emergencySaveAll() {
    for (const session of this.activeSessions.values()) {
      session.state = SESSION_STATES.RECORDING; // Mark as potentially incomplete
      session.emergencyShutdown = Date.now();
      this._saveSessionState(session);
    }
    console.log(`[SessionManager] Emergency saved ${this.activeSessions.size} sessions`);
  }

  /**
   * Cleanup old completed sessions (keep last N days)
   */
  async cleanupOldSessions(daysToKeep = 7) {
    const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);
    let cleaned = 0;
    
    try {
      const entries = readdirSync(this.baseDir, { withFileTypes: true });
      
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('session_')) {
          continue;
        }
        
        const sessionDir = path.join(this.baseDir, entry.name);
        const session = this._loadSessionState(sessionDir);
        
        if (session && session.state === SESSION_STATES.COMPLETED && session.endTime < cutoffTime) {
          // Don't actually delete, just log for now
          console.log(`[SessionManager] Would cleanup old session: ${entry.name}`);
          cleaned++;
        }
      }
    } catch (err) {
      console.error(`[SessionManager] Cleanup error:`, err.message);
    }
    
    return cleaned;
  }
}

export { SESSION_STATES };
