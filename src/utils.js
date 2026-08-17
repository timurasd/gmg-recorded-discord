import fs from 'fs/promises';
import path from 'path';

/**
 * Убедиться, что директория существует.
 */
export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Пауза в ms.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
