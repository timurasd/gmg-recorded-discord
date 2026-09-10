/**
 * RecoveryService - Crash recovery and session restoration
 * 
 * Features:
 * - Detect incomplete sessions on startup
 * - Recover partial recordings
 * - Mark recovered chunks
 * - Notify about recovered data
 */

import { existsSync, readdirSync, renameSync, statSync } from 'fs';
import path from 'path';
import { recoverIncompleteChunks } from '../recorder/chunk-writer.js';
import { SessionManager, SESSION_STATES } from '../recorder/session-manager.js';

export class RecoveryService {
  constructor(recordingsDir, sessionManager) {
    this.recordingsDir = recordingsDir;
    this.sessionManager = sessionManager;
  }

  /**
   * Run recovery on startup
   * Returns list of recovered sessions
   */
  async runRecovery() {
    console.log('[Recovery] Scanning for incomplete sessions...');
    
    const recovered = [];
    const sessions = this.sessionManager.findRecoverableSessions();
    
    for (const session of sessions) {
      console.log('[Recovery] Found incomplete session: ' + session.id);
      
      try {
        // Recover any incomplete chunks
        const chunks = await recoverIncompleteChunks(session.dir);
        
        // Update session state
        session.state = SESSION_STATES.RECOVERED;
        session.recoveredAt = Date.now();
        session.recoveredChunks = chunks.length;
        
        recovered.push({
          sessionId: session.id,
          channelName: session.channelName,
          durationMin: Math.round((session.endTime || session.emergencyShutdown || Date.now()) - session.startTime) / 60000,
          participants: Object.values(session.participants).map(function(p) { return p.userName; }),
          recoveredChunks: chunks.length,
          status: chunks.length > 0 ? 'partial_data' : 'no_data'
        });
        
        console.log('[Recovery] Recovered session ' + session.id + ' with ' + chunks.length + ' partial chunks');
      } catch (err) {
        console.error('[Recovery] Failed to recover session ' + session.id + ':', err.message);
      }
    }
    
    if (recovered.length === 0) {
      console.log('[Recovery] No incomplete sessions found');
    } else {
      console.log('[Recovery] Recovered ' + recovered.length + ' session(s)');
    }
    
    return recovered;
  }

  /**
   * Get recovery summary for notification
   */
  formatRecoverySummary(recovered) {
    if (recovered.length === 0) {
      return null;
    }
    
    const lines = ['[Recovery Report]', ''];
    
    for (const r of recovered) {
      lines.push('Session: ' + r.channelName);
      lines.push('  Duration: ~' + r.durationMin + ' min');
      lines.push('  Participants: ' + r.participants.join(', '));
      lines.push('  Status: ' + r.status);
      lines.push('');
    }
    
    return lines.join('\n');
  }

  /**
   * Check disk space
   */
  checkDiskSpace() {
    try {
      const { execSync } = require('child_process');
      const output = execSync('df -h ' + this.recordingsDir + ' | tail -1').toString();
      const parts = output.trim().split(/\s+/);
      
      return {
        total: parts[1],
        used: parts[2],
        available: parts[3],
        usePercent: parseInt(parts[4])
      };
    } catch (err) {
      return null;
    }
  }
}
