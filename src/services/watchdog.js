/**
 * Watchdog - Health monitoring and self-healing
 * 
 * Features:
 * - Heartbeat monitoring
 * - Memory usage tracking
 * - Event loop lag detection
 * - Auto-restart on freeze
 */

const WATCHDOG_TIMEOUT = 60000;  // 1 minute without heartbeat = frozen
const CHECK_INTERVAL = 10000;    // Check every 10 sec
const MEMORY_LIMIT_MB = 400;     // Restart if exceeds

export class Watchdog {
  constructor(options = {}) {
    this.timeout = options.timeout || WATCHDOG_TIMEOUT;
    this.checkInterval = options.checkInterval || CHECK_INTERVAL;
    this.memoryLimit = options.memoryLimit || MEMORY_LIMIT_MB;
    this.onTimeout = options.onTimeout || (() => process.exit(1));
    
    this.lastHeartbeat = Date.now();
    this.lastEventLoopCheck = Date.now();
    this.interval = null;
    this.isRunning = false;
  }

  /**
   * Start watchdog monitoring
   */
  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.lastHeartbeat = Date.now();
    
    this.interval = setInterval(() => {
      this._check();
    }, this.checkInterval);

    // Don't keep process alive just for watchdog
    this.interval.unref();
    
    console.log('[Watchdog] Started monitoring');
  }

  /**
   * Stop watchdog
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.isRunning = false;
    console.log('[Watchdog] Stopped');
  }

  /**
   * Signal that process is alive
   */
  kick() {
    this.lastHeartbeat = Date.now();
  }

  /**
   * Perform health check
   */
  _check() {
    const now = Date.now();
    
    // Check heartbeat
    const elapsed = now - this.lastHeartbeat;
    if (elapsed > this.timeout) {
      console.error(`[Watchdog] ❌ No heartbeat for ${elapsed}ms, triggering timeout handler`);
      this.onTimeout();
      return;
    }

    // Check memory usage
    const memUsage = process.memoryUsage();
    const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
    const rssMB = Math.round(memUsage.rss / 1024 / 1024);
    
    if (heapUsedMB > this.memoryLimit) {
      console.error(`[Watchdog] ❌ Memory limit exceeded: ${heapUsedMB}MB / ${this.memoryLimit}MB`);
      this.onTimeout();
      return;
    }

    // Check event loop lag
    const eventLoopLag = now - this.lastEventLoopCheck - this.checkInterval;
    this.lastEventLoopCheck = now;
    
    if (eventLoopLag > 1000) {
      console.warn(`[Watchdog] ⚠️ Event loop lag: ${eventLoopLag}ms`);
    }

    // Log health status periodically
    console.log(`[Watchdog] ✓ Health OK - Memory: ${heapUsedMB}MB heap, ${rssMB}MB RSS, Event loop lag: ${eventLoopLag}ms`);
  }

  /**
   * Get current health status
   */
  getStatus() {
    const memUsage = process.memoryUsage();
    return {
      uptime: process.uptime(),
      heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
      heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
      rssMB: Math.round(memUsage.rss / 1024 / 1024),
      lastHeartbeat: this.lastHeartbeat,
      isHealthy: (Date.now() - this.lastHeartbeat) < this.timeout
    };
  }
}
