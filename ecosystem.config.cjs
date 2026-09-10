module.exports = {
  apps: [{
    name: 'discord-recorder',
    script: 'src/index.js',
    cwd: '/root/apps/gmg-discord-recorder',
    node_args: '--max-old-space-size=512',
    autorestart: true,
    watch: false,
    max_memory_restart: '400M',
    restart_delay: 3000,
    exp_backoff_restart_delay: 100,
    max_restarts: 50,
    min_uptime: 10000,
    kill_timeout: 30000,
    wait_ready: true,
    listen_timeout: 30000,
    env: {
      NODE_ENV: 'production'
    },
    error_file: '/root/apps/gmg-discord-recorder/logs/error.log',
    out_file: '/root/apps/gmg-discord-recorder/logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
  }]
};
