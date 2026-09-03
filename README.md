# GMG Discord Voice Recorder

Discord бот для записи голосовых разговоров с автоматической транскрипцией (Whisper) и саммаризацией (Claude).

## Возможности

- 🎙️ Многоканальная запись (каждый участник записывается отдельно)
- 📝 Автоматическая транскрипция через локальный faster-whisper (бесплатно)
- 🤖 Саммаризация через Claude API (участники, темы, решения, action items)
- 📤 Отправка результатов в Discord и Telegram
- 🎵 Экспорт WAV файлов для каждого участника

## Требования

- Node.js 18+
- Python 3.8+
- FFmpeg
- faster-whisper (Python package)

## Установка

### 1. Клонировать репо

```bash
git clone https://github.com/timurasd/gmg-recorded-discord.git
cd gmg-recorded-discord
```

### 2. Установить зависимости

```bash
# Node.js dependencies
npm install

# Python dependencies
pip install faster-whisper
```

### 3. Настроить `.env`

Скопируй `.env.example` в `.env` и заполни:

```bash
cp .env.example .env
nano .env
```

Обязательные переменные:
- `DISCORD_TOKEN` — токен Discord бота
- `DISCORD_GUILD_ID` — ID сервера Discord
- `DISCORD_SUMMARY_CHANNEL_ID` — ID канала для сводок
- `ANTHROPIC_API_KEY` — Claude API ключ
- `TELEGRAM_BOT_TOKEN` — токен Telegram бота
- `TELEGRAM_CHAT_ID` — ID чата Telegram

### 4. Запустить бота

```bash
npm start
```

## Использование

1. Зайди в голосовой канал на Discord сервере
2. В текстовом канале напиши: `!join`
3. Бот подключится и начнёт запись
4. Поговори (можно с друзьями, можно один)
5. Когда закончил — напиши: `!leave`
6. Жди 1-3 минуты (транскрипция + саммаризация)
7. Результаты придут в Discord и Telegram:
   - `summary.txt` — краткая сводка
   - `transcript.txt` — полная расшифровка
   - `*.wav` — аудиофайлы каждого участника

## Telegram уведомления

Бот отправляет в Telegram:
- 🔴 Уведомление о начале записи
- ⏸️ Уведомление об окончании записи и начале обработки
- ✅ Уведомление о завершении с файлами:
  - `summary.txt`
  - `transcript.txt`
  - Все WAV файлы участников

## Деплой на сервер

### Через systemd

1. Скопируй файлы на сервер:

```bash
rsync -avz --exclude 'node_modules' --exclude 'recordings' \
  -e "ssh -i ~/.ssh/gmg_droplet_deploy" \
  ./ root@134.209.194.254:/root/apps/gmg-discord-recorder/
```

2. На сервере установи зависимости:

```bash
ssh -i ~/.ssh/gmg_droplet_deploy root@134.209.194.254
cd /root/apps/gmg-discord-recorder
npm install
pip install faster-whisper
```

3. Создай systemd service:

```bash
nano /etc/systemd/system/gmg-discord-recorder.service
```

```ini
[Unit]
Description=GMG Discord Voice Recorder
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/apps/gmg-discord-recorder
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10
StandardOutput=append:/var/log/gmg-discord-recorder.log
StandardError=append:/var/log/gmg-discord-recorder.error.log

[Install]
WantedBy=multi-user.target
```

4. Запусти сервис:

```bash
systemctl daemon-reload
systemctl enable gmg-discord-recorder
systemctl start gmg-discord-recorder
systemctl status gmg-discord-recorder
```

## Логи

```bash
# Локально
npm start

# На сервере (systemd)
journalctl -u gmg-discord-recorder -f

# Или файлы логов
tail -f /var/log/gmg-discord-recorder.log
tail -f /var/log/gmg-discord-recorder.error.log
```

## Настройка качества транскрипции

В `.env` измени `WHISPER_MODEL`:

- `tiny` — очень быстро, низкое качество
- `base` — быстро, средне качество (по умолчанию)
- `small` — медленнее, хорошее качество ✅ **рекомендуется для русского**
- `medium` — медленно, отличное качество
- `large-v3` — очень медленно, максимальное качество

## Стоимость

- **Транскрипция (Whisper):** БЕСПЛАТНО (работает локально)
- **Саммаризация (Claude):** ~$0.01 за 30 минут разговора

## Архитектура

```
Discord Voice (Opus)
  ↓
Декодирование (prism-media)
  ↓
PCM аудио (каждый спикер отдельно)
  ↓
Конвертация в WAV (ffmpeg)
  ↓
Локальная транскрипция (faster-whisper)
  ↓
Саммаризация (Claude API)
  ↓
Результаты → Discord + Telegram
```

## Troubleshooting

### Бот не слышит голос

- Проверь что говоришь **ПОСЛЕ** `!join`
- Убедись что микрофон работает в Discord
- Проверь права бота (Connect, Speak, View Channel)

### Транскрипция пустая

- Говори громче и чётче
- Смени модель на `small` в `.env`
- Первый раз Whisper загружает модель (~150MB) — потерпи

### Ошибка Claude API

- Проверь баланс на https://console.anthropic.com/
- Проверь что API ключ правильный в `.env`

## Лицензия

MIT

## Credits

Основано на [discord-secretary-bot](https://github.com/andrew-sidenko/discord-secretary-bot) by Andrew Sidenko

Модифицировано для GMG:
- Заменён OpenAI Whisper API на локальный faster-whisper
- Заменён OpenAI GPT на Claude API
- Добавлены уведомления в Telegram о начале/конце записи
- Добавлена отправка WAV файлов в Telegram
- Исправлена отправка длинных summary в Discord
