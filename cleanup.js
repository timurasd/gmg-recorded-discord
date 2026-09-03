import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';

const RECORDINGS_DIR = process.env.AUDIO_OUTPUT_DIR || './recordings';
const WARN_DAYS = 6; // Предупреждение за 24ч
const DELETE_DAYS = 7; // Удаление через 7 дней

/**
 * Отправить сообщение в Telegram
 */
async function sendTelegram(message) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  
  if (!chatId || !token) {
    console.log('⚠️ Telegram не настроен, пропускаю уведомление');
    return;
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        chat_id: chatId,
        text: message,
        parse_mode: 'Markdown',
      },
    );
    console.log('✅ Telegram уведомление отправлено');
  } catch (err) {
    console.error('❌ Ошибка отправки в Telegram:', err.message);
  }
}

/**
 * Получить timestamp из имени папки session_TIMESTAMP
 */
function getSessionTimestamp(dirname) {
  const match = dirname.match(/session_(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Форматировать дату для удобного чтения
 */
function formatDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleString('ru-RU', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Получить размер папки в MB
 */
async function getFolderSize(folderPath) {
  let totalSize = 0;
  
  try {
    const files = await fs.readdir(folderPath, { withFileTypes: true });
    
    for (const file of files) {
      const filePath = path.join(folderPath, file.name);
      
      if (file.isDirectory()) {
        totalSize += await getFolderSize(filePath);
      } else {
        const stats = await fs.stat(filePath);
        totalSize += stats.size;
      }
    }
  } catch (err) {
    console.error(`Ошибка подсчёта размера ${folderPath}:`, err.message);
  }
  
  return totalSize;
}

/**
 * Основная функция очистки
 */
async function cleanup() {
  console.log('🧹 Запуск очистки старых записей...');
  console.log(`📁 Папка: ${RECORDINGS_DIR}`);
  
  try {
    const entries = await fs.readdir(RECORDINGS_DIR, { withFileTypes: true });
    const now = Date.now();
    
    const warnThreshold = WARN_DAYS * 24 * 60 * 60 * 1000;
    const deleteThreshold = DELETE_DAYS * 24 * 60 * 60 * 1000;
    
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('session_')) {
        continue;
      }
      
      const sessionTimestamp = getSessionTimestamp(entry.name);
      if (!sessionTimestamp) {
        console.log(`⚠️ Не могу распарсить timestamp из ${entry.name}`);
        continue;
      }
      
      const age = now - sessionTimestamp;
      const ageDays = Math.floor(age / (24 * 60 * 60 * 1000));
      const sessionPath = path.join(RECORDINGS_DIR, entry.name);
      
      // Удаление (старше 7 дней)
      if (age >= deleteThreshold) {
        const size = await getFolderSize(sessionPath);
        const sizeMB = (size / 1024 / 1024).toFixed(1);
        
        console.log(`🗑️ Удаляю запись ${entry.name} (${ageDays} дней, ${sizeMB} MB)`);
        
        await fs.rm(sessionPath, { recursive: true, force: true });
        
        await sendTelegram(
          `🗑️ *Запись удалена*\n\n` +
          `📅 Дата: ${formatDate(sessionTimestamp)}\n` +
          `⏱️ Возраст: ${ageDays} дней\n` +
          `💾 Размер: ${sizeMB} MB\n` +
          `📂 ID: \`${entry.name}\``
        );
        
        console.log(`✅ Запись ${entry.name} удалена`);
      }
      // Предупреждение (старше 6 дней)
      else if (age >= warnThreshold) {
        const hoursLeft = Math.floor((deleteThreshold - age) / (60 * 60 * 1000));
        const size = await getFolderSize(sessionPath);
        const sizeMB = (size / 1024 / 1024).toFixed(1);
        
        console.log(`⚠️ Предупреждение для ${entry.name} (удалю через ${hoursLeft}ч)`);
        
        await sendTelegram(
          `⚠️ *Запись будет удалена через ${hoursLeft}ч*\n\n` +
          `📅 Дата: ${formatDate(sessionTimestamp)}\n` +
          `⏱️ Возраст: ${ageDays} дней\n` +
          `💾 Размер: ${sizeMB} MB\n` +
          `📂 ID: \`${entry.name}\`\n\n` +
          `Если нужна запись — скачай файлы с сервера сейчас.`
        );
      }
    }
    
    console.log('✅ Очистка завершена');
  } catch (err) {
    console.error('❌ Ошибка при очистке:', err);
    
    await sendTelegram(
      `❌ *Ошибка очистки записей*\n\n` +
      `\`${err.message}\``
    );
  }
}

// Запуск
cleanup().catch(console.error);
