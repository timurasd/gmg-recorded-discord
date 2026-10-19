/**
 * Watchdog - restarts the bot only when it is really stuck.
 *
 * The old version expected a "heartbeat" that only came from Discord chat
 * messages: two minutes without anyone typing and it killed the process --
 * mid-recording, mid-transcription, and every 2 minutes when idle. That made
 * ~650 Discord logins a day (2026-10-19: 14,000+ restarts) and nothing longer
 * than 2 minutes was ever recorded.
 *
 * Now it looks at what matters: the Discord connection (discord.js reconnects
 * on its own; we step in only if it stays down for long) and memory. It never
 * restarts while a recording or its processing is running.
 */

const CHECK_INTERVAL_MS = 30_000;
const DISCONNECT_LIMIT_MS = 10 * 60_000;
const MEMORY_LIMIT_MB = 400;
const HEALTH_LOG_EVERY_MS = 10 * 60_000;

export class Watchdog {
  constructor({ isConnected, isBusy, onFatal, checkInterval = CHECK_INTERVAL_MS, disconnectLimit = DISCONNECT_LIMIT_MS, memoryLimit = MEMORY_LIMIT_MB }) {
    this.isConnected = isConnected;
    this.isBusy = isBusy;
    this.onFatal = onFatal;
    this.checkInterval = checkInterval;
    this.disconnectLimit = disconnectLimit;
    this.memoryLimit = memoryLimit;
    this.disconnectedSince = null;
    this.lastHealthLog = 0;
    this.lastCheck = Date.now();
    this.interval = null;
  }

  start() {
    if (this.interval) return;
    this.lastCheck = Date.now();
    this.interval = setInterval(() => this._check(), this.checkInterval);
    this.interval.unref();
    console.log('[Watchdog] Started monitoring');
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  _check() {
    const now = Date.now();
    const lag = now - this.lastCheck - this.checkInterval;
    this.lastCheck = now;
    const busy = this.isBusy();

    if (this.isConnected()) {
      if (this.disconnectedSince) console.log('[Watchdog] Discord connection is back');
      this.disconnectedSince = null;
    } else {
      this.disconnectedSince ??= now;
      const downMs = now - this.disconnectedSince;
      if (downMs > this.disconnectLimit && !busy) {
        this.onFatal(`no Discord connection for ${Math.round(downMs / 60_000)} min`);
        return;
      }
    }

    const heapMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    if (heapMb > this.memoryLimit) {
      if (!busy) {
        this.onFatal(`memory ${heapMb} MB over ${this.memoryLimit} MB`);
        return;
      }
      console.warn(`[Watchdog] Memory ${heapMb} MB over the limit, waiting for the recording to finish`);
    }

    if (lag > 5000) console.warn(`[Watchdog] Event loop lag: ${lag} ms`);
    if (now - this.lastHealthLog >= HEALTH_LOG_EVERY_MS) {
      this.lastHealthLog = now;
      console.log(`[Watchdog] OK - heap ${heapMb} MB, connected: ${!this.disconnectedSince}, busy: ${busy}`);
    }
  }

  getStatus() {
    const mem = process.memoryUsage();
    return {
      uptime: process.uptime(),
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024),
      connected: this.isConnected(),
    };
  }
}
