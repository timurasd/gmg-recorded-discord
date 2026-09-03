# Инструкция по настройке Discord Secretary Bot (OpenAI версия)

Бот модифицирован для работы с **OpenAI API** вместо локального Ollama.

## ✅ Что готово:
- Код модифицирован для OpenAI Chat API (саммаризация)
- Код модифицирован для OpenAI Whisper API (транскрипция)
- Зависимости установлены (`npm install` выполнен)
- `.env` файл создан

---

## 📋 Что нужно сделать:

### 1. Создать Discord бота

1. Зайди на https://discord.com/developers/applications
2. Нажми **New Application** → введи имя бота
3. Во вкладке **Bot**:
   - Нажми **Reset Token** → скопируй токен
   - Включи **Privileged Gateway Intents**:
     - ✅ Server Members Intent
     - ✅ Message Content Intent
     - ✅ Presence Intent
4. Во вкладке **OAuth2 → URL Generator**:
   - Выбери **bot** и **applications.commands**
   - В Bot Permissions выбери:
     - ✅ Read Messages/View Channels
     - ✅ Send Messages
     - ✅ Attach Files
     - ✅ Connect
     - ✅ Speak
   - Скопируй сгенерированный URL и открой его в браузере
   - Добавь бота на свой сервер

### 2. Получить ID для Discord

1. Включи Developer Mode в Discord:
   - Настройки → Advanced → Developer Mode (включи)
2. Получи **Server ID**:
   - ПКМ по иконке сервера → Copy Server ID
3. Получи **Channel ID** (канал, куда бот будет отправлять сводки):
   - ПКМ по текстовому каналу → Copy Channel ID

### 3. Получить OpenAI API Key

1. Зайди на https://platform.openai.com/api-keys
2. Нажми **Create new secret key** → скопируй ключ
3. **Важно**: убедись что у тебя есть деньги на балансе OpenAI

### 4. Настроить .env

Открой файл `.env` и заполни:

```bash
DISCORD_TOKEN=твой_токен_бота
DISCORD_GUILD_ID=твой_server_id
DISCORD_SUMMARY_CHANNEL_ID=твой_channel_id
OPENAI_API_KEY=твой_openai_ключ

# Опционально: модель для саммаризации (по умолчанию gpt-4o-mini)
OPENAI_MODEL=gpt-4o-mini

# Опционально: язык транскрипции
WHISPER_LANGUAGE=ru
```

### 5. Запустить бота

```bash
npm start
```

Бот должен залогиниться и вывести: `Bot logged in as [имя бота]#0000`

---

## 🎮 Команды бота в Discord:

### `!join`
Бот подключится к голосовому каналу, где ты находишься, и начнёт запись.

### `!leave`
Бот остановит запись, сделает транскрипцию и саммаризацию, отправит результаты в канал.

### `!status`
Проверить, идёт ли запись.

---

## 💰 Стоимость OpenAI API:

### Whisper API (транскрипция):
- $0.006 за минуту аудио
- Пример: 30 минут разговора = **$0.18**

### GPT-4o-mini (саммаризация):
- ~$0.15 за 1M входных токенов
- ~$0.60 за 1M выходных токенов
- Пример: саммаризация 30 минут текста ≈ **$0.02-0.05**

**Итого**: 30-минутный созвон ≈ **$0.20-0.25**

---

## 🔧 Требования:

✅ **Node.js >= 20** (у тебя уже есть)
✅ **ffmpeg** (у тебя уже установлен)
✅ **OpenAI API key** с балансом
✅ **Discord Bot Token**

---

## 📂 Структура:

- `src/index.js` — точка входа, обработка команд
- `src/recorder.js` — многоканальная запись голоса
- `src/transcribe.js` — транскрипция через OpenAI Whisper API
- `src/summarize.js` — саммаризация через OpenAI Chat API
- `src/delivery.js` — отправка результатов в Discord/Telegram
- `recordings/` — папка с записями (создастся автоматически)

---

## ❗ Возможные проблемы:

### Ошибка "DISCORD_TOKEN is required"
→ Заполни .env файл

### Ошибка "ffmpeg not found"
→ Установи ffmpeg: `brew install ffmpeg`

### Ошибка OpenAI API
→ Проверь баланс на https://platform.openai.com/account/billing

### Бот не слышит голос
→ Убедись, что включен **Server Members Intent** в настройках бота

---

## 🚀 Готово!

После настройки:
1. Запусти бота: `npm start`
2. Зайди в голосовой канал в Discord
3. Напиши в текстовом канале: `!join`
4. Поговори
5. Напиши: `!leave`
6. Жди результаты в канале!

---

**Путь к боту**: `/var/folders/4n/qpqncdwd00n9mfpl6_hl2y5h0000gn/T/opencode/discord-secretary-bot`
