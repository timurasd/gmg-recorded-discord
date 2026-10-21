import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMarkers,
  byteToMeetingMs,
  mergeSegments,
  formatClock,
  formatTranscript,
  mixPlacements,
} from '../src/timeline.js';

test('parseMarkers sorts and skips a torn last line', () => {
  const m = parseMarkers('{"byte":192000,"ms":60000}\n{"byte":0,"ms":1000}\n{"byte":38');
  assert.deepEqual(m, [{ byte: 0, ms: 1000 }, { byte: 192000, ms: 60000 }]);
});

test('byteToMeetingMs maps file position to meeting time across utterances', () => {
  // Utterance 1: 1 s of audio said at 00:01; utterance 2 said at 01:00.
  const markers = [{ byte: 0, ms: 1000 }, { byte: 192000, ms: 60000 }];
  assert.equal(byteToMeetingMs(markers, 0), 1000);
  assert.equal(byteToMeetingMs(markers, 96000), 1500);
  assert.equal(byteToMeetingMs(markers, 192000), 60000);
  assert.equal(byteToMeetingMs(markers, 288000), 60500);
  assert.equal(byteToMeetingMs([], 192000), 1000);
});

test('mergeSegments interleaves speakers in meeting order and joins close lines', () => {
  const lines = mergeSegments([
    {
      name: 'Тимур',
      markers: [{ byte: 0, ms: 5000 }, { byte: 192000 * 2, ms: 20000 }],
      segments: [
        { start: 0, end: 1, text: 'Привет.' },
        { start: 1.5, end: 2, text: 'Начнём?' },
        { start: 2, end: 3, text: 'Ещё вопрос.' },
      ],
    },
    {
      name: 'Юра',
      markers: [{ byte: 0, ms: 10000 }],
      segments: [{ start: 0, end: 2, text: 'Да, давай.' }, { start: 2, end: 2, text: '  ' }],
    },
  ]);
  assert.deepEqual(
    lines.map((l) => [l.startMs, l.speaker, l.text]),
    [
      [5000, 'Тимур', 'Привет. Начнём?'],
      [10000, 'Юра', 'Да, давай.'],
      [20000, 'Тимур', 'Ещё вопрос.'],
    ]
  );
  assert.equal(formatTranscript(lines).split('\n')[1], '[00:10] Юра: Да, давай.');
});

test('formatClock adds hours only when needed', () => {
  assert.equal(formatClock(65000), '01:05');
  assert.equal(formatClock(3723000), '01:02:03');
});

test('mixPlacements puts each utterance at its meeting time', () => {
  // 48k stereo bytes -> 16k mono samples is /12; ms -> samples is *16.
  const p = mixPlacements([{ byte: 0, ms: 1000 }, { byte: 192000, ms: 60000 }], 32000);
  assert.deepEqual(p, [
    { srcStart: 0, srcEnd: 16000, dstStart: 16000 },
    { srcStart: 16000, srcEnd: 32000, dstStart: 960000 },
  ]);
});

test('words place a stitched Whisper segment back into its two utterances', () => {
  // VAD stitched an utterance said at 00:02 and one said at 01:00 into one segment.
  const lines = mergeSegments([{
    name: 'Андрей',
    markers: [{ byte: 0, ms: 2000 }, { byte: 192000 * 2, ms: 60000 }],
    segments: [{
      start: 0, end: 3, text: 'Привет. Пока.',
      words: [[0, 0.5, ' Привет.'], [2.2, 2.8, ' Пока.']],
    }],
  }, {
    name: 'Юра',
    markers: [{ byte: 0, ms: 30000 }],
    segments: [{ start: 0, end: 1, text: 'Ага', words: [[0, 1, ' Ага']] }],
  }]);
  assert.deepEqual(lines.map((l) => [l.startMs, l.speaker, l.text]), [
    [2000, 'Андрей', 'Привет.'],
    [30000, 'Юра', 'Ага'],
    [60200, 'Андрей', 'Пока.'],
  ]);
});

test('pieceRanges cuts long audio in the pauses between utterances, under the limit', async () => {
  const { pieceRanges, markersWithGaps, PCM_BYTES_PER_MS } = await import('../src/timeline.js');
  const sec = PCM_BYTES_PER_MS * 1000;
  // utterances starting every 4 min of audio, 25 min in total
  const raw = [0, 240, 480, 720, 960, 1200, 1440].map((s, i) => ({ byte: s * sec, ms: i * 600000 }));
  const fileMarkers = markersWithGaps(raw);
  const total = 1500 + 6; // + six 1 s gaps
  const ranges = pieceRanges(fileMarkers, total, 600);
  assert.ok(ranges.every((r) => r.end - r.start <= 600));
  assert.equal(ranges[0].start, 0);
  assert.equal(ranges[ranges.length - 1].end, total);
  // every cut is in the middle of an inserted second of silence
  for (const r of ranges.slice(1)) assert.ok(fileMarkers.some((m) => Math.abs(m.byte / sec - 0.5 - r.start) < 1e-9));
  assert.deepEqual(pieceRanges(fileMarkers, 300, 600), [{ start: 0, end: 300 }]);
});

test('shiftSegments moves a piece back to file time, words included', async () => {
  const { shiftSegments } = await import('../src/timeline.js');
  assert.deepEqual(shiftSegments([{ start: 1, end: 2, text: 'а', words: [[1, 2, ' а']] }], 600.5), [
    { start: 601.5, end: 602.5, text: 'а', words: [[601.5, 602.5, ' а']] },
  ]);
});

test('subtitle-credit hallucinations are cut out, real words kept', async () => {
  const { stripHallucinations, mergeSegments } = await import('../src/timeline.js');
  assert.equal(stripHallucinations('Ага, вот что... Редактор субтитров И.Бойкова'), 'Ага, вот что...');
  assert.equal(stripHallucinations('Продолжение следует... Субтитры сделал DimaTorzok'), '');
  assert.equal(stripHallucinations('Нужен корректор текста для постов.'), 'Нужен корректор текста для постов.');
  const lines = mergeSegments([{ name: 'А', markers: [], segments: [{ start: 0, end: 1, text: 'Спасибо за просмотр!' }] }]);
  assert.deepEqual(lines, []);
});
