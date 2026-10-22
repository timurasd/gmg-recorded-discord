import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wavSamples } from '../src/mix.js';
import { splitText } from '../src/delivery.js';

function wav(samples, withList = true) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(s, i * 2));
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(1, 10); fmt.writeUInt32LE(16000, 12);
  fmt.writeUInt32LE(32000, 16); fmt.writeUInt16LE(2, 20); fmt.writeUInt16LE(16, 22);
  const list = Buffer.from('LIST\x05\x00\x00\x00INFOx\x00', 'binary'); // odd size + pad byte, like ffmpeg's
  const head = Buffer.alloc(8);
  head.write('data', 0, 'ascii');
  head.writeUInt32LE(data.length, 4);
  const body = Buffer.concat([Buffer.from('WAVE'), fmt, ...(withList ? [list] : []), head, data]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

test('wavSamples finds the data chunk past a LIST chunk', () => {
  assert.deepEqual(Array.from(wavSamples(wav([1, -2, 32767]))), [1, -2, 32767]);
  assert.deepEqual(Array.from(wavSamples(wav([5], false))), [5]);
});

test('splitText keeps pieces under the limit and splits on lines', () => {
  const parts = splitText('aaaa\nbbbb\ncccc', 10);
  assert.deepEqual(parts, ['aaaa\nbbbb', 'cccc']);
  assert.ok(splitText('x'.repeat(25), 10).every((p) => p.length <= 10));
});

test('every module loads (no broken imports)', async () => {
  for (const m of ['pipeline', 'mix', 'delivery', 'summarize', 'transcribe', 'services/recovery', 'services/watchdog', 'recorder/session-manager']) {
    await import(`../src/${m}.js`);
  }
});

test('utterance gaps land exactly at the markers, also across chunk files', async () => {
  const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { concatenateChunkFilesWithGaps } = await import('../src/recorder/chunk-writer.js');
  const { markersWithGaps } = await import('../src/timeline.js');

  const dir = mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  const a = path.join(dir, 'chunk_0000.pcm.complete');
  const b = path.join(dir, 'chunk_0001.pcm.complete');
  writeFileSync(a, Buffer.from([1, 1, 1, 2, 2]));
  writeFileSync(b, Buffer.from([2, 3, 3]));
  // utterances start at bytes 0, 3 (inside chunk a) and 6 (inside chunk b)
  const markers = [{ byte: 0, ms: 0 }, { byte: 3, ms: 5000 }, { byte: 6, ms: 9000 }];
  const out = path.join(dir, 'out.pcm');
  await concatenateChunkFilesWithGaps([a, b], out, markers, 2);
  assert.deepEqual(Array.from(readFileSync(out)), [1, 1, 1, 0, 0, 2, 2, 2, 0, 0, 3, 3]);
  // shifted markers point at the first byte of each utterance in the new file
  assert.deepEqual(markersWithGaps(markers, 2).map((m) => m.byte), [0, 5, 10]);
});

test('archiveText keeps summary + transcript as call_<Moscow time>.txt', async () => {
  const { mkdtempSync, readFileSync, readdirSync } = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  process.env.ARCHIVE_DIR = dir;
  const { archiveText } = await import('../src/pipeline.js');
  // 2026-10-21 11:05 UTC = 14:05 МСК
  await archiveText({ startTime: Date.UTC(2026, 9, 21, 11, 5), summary: 'Кратко: тест.', transcript: '[00:01] А: привет\n' });
  await archiveText({ startTime: Date.UTC(2026, 9, 21, 11, 5), summary: null, summaryError: 'нет ключа', transcript: 'x\n' });
  const files = readdirSync(dir).sort();
  assert.equal(files[0], 'call_2026-10-21_14-05.txt');
  assert.equal(files.length, 2); // same minute -> second file gets a suffix, nothing overwritten
  const text = readFileSync(path.join(dir, files[0]), 'utf-8');
  assert.ok(text.startsWith('СВОДКА\n\nКратко: тест.') && text.includes('РАСШИФРОВКА\n\n[00:01] А: привет'));
  delete process.env.ARCHIVE_DIR;
});
