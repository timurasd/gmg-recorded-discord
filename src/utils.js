import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';

/**
 * Ensure directory exists (async)
 */
export async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return dir;
}

/**
 * Ensure directory exists (sync)
 */
export function ensureDirSync(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Sleep for ms milliseconds
 */
export function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

/**
 * Format duration in seconds to human readable
 */
export function formatDuration(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins === 0) return secs + ' сек';
  return mins + ' мин ' + secs + ' сек';
}
