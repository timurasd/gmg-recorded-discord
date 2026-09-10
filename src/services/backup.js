/**
 * BackupService - Automatic backup and archival
 * 
 * Features:
 * - Archive completed sessions
 * - Compress old recordings
 * - Cleanup old backups
 */

import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync } from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const MAX_BACKUP_AGE_DAYS = 30;

export class BackupService {
  constructor(recordingsDir, backupsDir) {
    this.recordingsDir = recordingsDir;
    this.backupsDir = backupsDir;
    
    mkdirSync(backupsDir, { recursive: true });
  }

  /**
   * Archive a completed session
   */
  archiveSession(sessionDir) {
    const sessionName = path.basename(sessionDir);
    const archivePath = path.join(this.backupsDir, sessionName + '.tar.gz');
    
    if (existsSync(archivePath)) {
      console.log('[Backup] Archive already exists: ' + sessionName);
      return archivePath;
    }

    try {
      // Create tar.gz archive
      const cmd = 'tar -czf "' + archivePath + '" -C "' + path.dirname(sessionDir) + '" "' + sessionName + '"';
      execSync(cmd, { timeout: 60000 });
      
      const stats = statSync(archivePath);
      console.log('[Backup] Archived ' + sessionName + ': ' + (stats.size / 1024 / 1024).toFixed(2) + ' MB');
      
      return archivePath;
    } catch (err) {
      console.error('[Backup] Failed to archive ' + sessionName + ':', err.message);
      return null;
    }
  }

  /**
   * Cleanup old archives
   */
  cleanupOldBackups() {
    const cutoffTime = Date.now() - (MAX_BACKUP_AGE_DAYS * 24 * 60 * 60 * 1000);
    let cleaned = 0;
    
    try {
      const files = readdirSync(this.backupsDir);
      
      for (const file of files) {
        if (!file.endsWith('.tar.gz')) continue;
        
        const filePath = path.join(this.backupsDir, file);
        const stats = statSync(filePath);
        
        if (stats.mtimeMs < cutoffTime) {
          rmSync(filePath);
          console.log('[Backup] Deleted old backup: ' + file);
          cleaned++;
        }
      }
    } catch (err) {
      console.error('[Backup] Cleanup error:', err.message);
    }
    
    return cleaned;
  }

  /**
   * Get backup stats
   */
  getStats() {
    let totalSize = 0;
    let count = 0;
    
    try {
      const files = readdirSync(this.backupsDir);
      
      for (const file of files) {
        if (!file.endsWith('.tar.gz')) continue;
        
        const filePath = path.join(this.backupsDir, file);
        const stats = statSync(filePath);
        totalSize += stats.size;
        count++;
      }
    } catch (err) {
      // Directory might not exist
    }
    
    return {
      count,
      totalSizeMB: Math.round(totalSize / 1024 / 1024)
    };
  }

  /**
   * List all backups
   */
  listBackups() {
    const backups = [];
    
    try {
      const files = readdirSync(this.backupsDir);
      
      for (const file of files) {
        if (!file.endsWith('.tar.gz')) continue;
        
        const filePath = path.join(this.backupsDir, file);
        const stats = statSync(filePath);
        
        backups.push({
          name: file,
          path: filePath,
          sizeMB: Math.round(stats.size / 1024 / 1024 * 100) / 100,
          created: stats.mtime
        });
      }
    } catch (err) {
      // Directory might not exist
    }
    
    return backups.sort((a, b) => b.created - a.created);
  }
}
