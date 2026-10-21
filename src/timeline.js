/**
 * Timeline - where each piece of a user's audio sits in the meeting.
 *
 * Discord only sends audio while someone talks, so a user's PCM file is their
 * utterances back to back, with no silence in between. When an utterance
 * starts, the recorder writes a marker: the byte offset it starts at in that
 * file and the meeting time (ms since !join). With those, any position in the
 * file maps back to meeting time -- which is what lets the transcript go in
 * the order things were said, and the audio be mixed into one track.
 */

// Decoded Discord audio: 48 kHz, stereo, signed 16-bit -> 4 bytes per frame.
export const PCM_BYTES_PER_MS = 192;
// The 16 kHz mono files made for Whisper: 12 bytes of 48 kHz stereo PCM per sample.
export const PCM_BYTES_PER_16K_SAMPLE = 12;

/**
 * Parse a markers file (one JSON object per line: {"byte": n, "ms": n}),
 * skipping a torn last line after a crash. Sorted by byte offset.
 */
export function parseMarkers(text) {
  const markers = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      if (Number.isFinite(m.byte) && Number.isFinite(m.ms)) markers.push({ byte: m.byte, ms: m.ms });
    } catch {
      // half-written line from a crash -- ignore
    }
  }
  return markers.sort((a, b) => a.byte - b.byte);
}

// Silence put between utterances when the PCM is assembled for Whisper: back
// to back, Whisper runs the end of one utterance into the next (seen on the
// first real test, 2026-10-19); a 1 s pause makes it split there.
export const UTTERANCE_GAP_BYTES = PCM_BYTES_PER_MS * 1000;

/**
 * Markers for the PCM with a gap inserted before every utterance that doesn't
 * start the file: each marker moves by the gaps inserted before it.
 */
export function markersWithGaps(markers, gapBytes = UTTERANCE_GAP_BYTES) {
  let inserted = 0;
  return markers.map((m) => {
    if (m.byte > 0) inserted += gapBytes;
    return { byte: m.byte + inserted, ms: m.ms };
  });
}

/**
 * Meeting time (ms) of a byte offset in a user's PCM file. `isEnd`: the offset
 * ends a piece, so one sitting exactly on an utterance boundary belongs to the
 * utterance before it, not the next one.
 */
export function byteToMeetingMs(markers, byte, isEnd = false) {
  if (markers.length === 0) return Math.round(byte / PCM_BYTES_PER_MS);
  let m = markers[0];
  for (const candidate of markers) {
    if (isEnd ? candidate.byte >= byte : candidate.byte > byte) break;
    m = candidate;
  }
  return Math.round(m.ms + (byte - m.byte) / PCM_BYTES_PER_MS);
}

/** Meeting time (ms) of a moment (seconds) in the user's audio file. */
export function fileSecondsToMeetingMs(markers, seconds, isEnd = false) {
  return byteToMeetingMs(markers, Math.round(seconds * 1000 * PCM_BYTES_PER_MS), isEnd);
}

/**
 * Whisper segments of every user -> one list in meeting order. A speaker's
 * consecutive pieces less than `joinGapMs` apart become one line.
 *
 * A segment with per-word times ([start, end, word], the word with its
 * leading space) is placed word by word: Whisper's VAD can stitch two
 * utterances said a minute apart into one segment, and only the words know
 * which one they came from.
 *
 * users: [{ name, markers, segments: [{ start, end, text, words? }] }]
 */
export function mergeSegments(users, joinGapMs = 3000) {
  const lines = [];
  for (const user of users) {
    const pieces = [];
    for (const seg of user.segments || []) {
      const parts = Array.isArray(seg.words) && seg.words.length > 0
        ? seg.words.map(([start, end, word]) => ({ start, end, text: String(word), spaced: true }))
        : [{ start: seg.start, end: seg.end, text: String(seg.text || '').trim(), spaced: false }];
      for (const p of parts) {
        if (!p.text.trim()) continue;
        pieces.push({
          startMs: fileSecondsToMeetingMs(user.markers, p.start),
          endMs: fileSecondsToMeetingMs(user.markers, p.end, true),
          text: p.text,
          spaced: p.spaced,
        });
      }
    }
    pieces.sort((a, b) => a.startMs - b.startMs);

    // Group one speaker's words into their lines first, then order everyone's
    // lines by time -- sorting words across speakers would chop crosstalk
    // into one-word lines.
    let current = null;
    for (const piece of pieces) {
      if (current && piece.startMs - current.endMs < joinGapMs) {
        current.text += piece.spaced ? piece.text : ' ' + piece.text;
        current.endMs = Math.max(current.endMs, piece.endMs);
      } else {
        current = { speaker: user.name, startMs: piece.startMs, endMs: piece.endMs, text: piece.text };
        lines.push(current);
      }
    }
  }
  for (const line of lines) line.text = stripHallucinations(line.text);
  return lines.filter((l) => l.text).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

/**
 * Where to cut a user's audio into pieces of at most `maxPieceSec` for
 * Whisper, whose memory grows with file length (2026-10-21: 80 min of one
 * speaker took 4 GB and was OOM-killed; 10 min takes 1.4 GB). Cuts go in the
 * middle of the silence inserted before an utterance (markersWithGaps), so no
 * word is split. Returns [{ start, end }] in seconds of the file.
 */
export function pieceRanges(fileMarkers, totalSec, maxPieceSec = 600, gapBytes = UTTERANCE_GAP_BYTES) {
  const cuts = fileMarkers
    .filter((m) => m.byte >= gapBytes)
    .map((m) => (m.byte - gapBytes / 2) / (PCM_BYTES_PER_MS * 1000))
    .filter((s) => s > 0 && s < totalSec)
    .sort((a, b) => a - b);

  const ranges = [];
  let start = 0;
  while (totalSec - start > maxPieceSec) {
    // the last silence that still keeps this piece under the limit
    let cut = null;
    for (const c of cuts) {
      if (c <= start) continue;
      if (c - start > maxPieceSec) break;
      cut = c;
    }
    if (cut === null) cut = start + maxPieceSec; // one utterance longer than a piece
    ranges.push({ start, end: cut });
    start = cut;
  }
  ranges.push({ start, end: totalSec });
  return ranges;
}

/** Whisper segments of a piece starting `offsetSec` into the file -> file times. */
export function shiftSegments(segments, offsetSec) {
  if (!offsetSec) return segments;
  const r = (x) => Math.round((x + offsetSec) * 100) / 100;
  return segments.map((s) => ({
    ...s,
    start: r(s.start),
    end: r(s.end),
    ...(Array.isArray(s.words) ? { words: s.words.map(([a, b, w]) => [r(a), r(b), w]) } : {}),
  }));
}

// Phrases Whisper "hears" in Russian at the end of a stretch of audio -- credits
// from the subtitles it was trained on (seen 2026-10-21: "Редактор субтитров
// И.Бойкова" tacked onto a real sentence). Removed from the transcript.
// A credited name: optional initials ("И.", "А. ") then a surname or nickname.
const NAME = String.raw`(?:\s*(?:[А-ЯЁA-Z]\.\s*)*[A-Za-zА-ЯЁа-яё-]+)?`;
const HALLUCINATIONS = [
  new RegExp(String.raw`Редактор субтитров${NAME}[.!?]?`, 'gi'),
  new RegExp(String.raw`Корректор\s+(?:[А-ЯЁ]\.\s*)+[А-ЯЁ][а-яё]+[.!?]?`, 'g'),
  new RegExp(String.raw`Субтитры\s+(?:сделал|создавал|делал|подготовил|подогнал)${NAME}[.!?]?`, 'gi'),
  new RegExp(String.raw`Субтитры\s+(?:от|by)${NAME}[.!?]?`, 'gi'),
  /Продолжение следует\.{0,3}/gi,
  /Спасибо за просмотр[!.]?/gi,
  /DimaTorzok/gi,
];

export function stripHallucinations(text) {
  let out = String(text);
  for (const re of HALLUCINATIONS) out = out.replace(re, ' ');
  return out.replace(/\s{2,}/g, ' ').trim();
}

/** 00:05 / 01:02:03 */
export function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return h > 0 ? `${String(h).padStart(2, '0')}:${mmss}` : mmss;
}

export function formatTranscript(lines) {
  return lines.map((l) => `[${formatClock(l.startMs)}] ${l.speaker}: ${l.text}`).join('\n');
}

/**
 * Where each marker interval of a user's 16 kHz audio goes in the mixed
 * track: [{ srcStart, srcEnd, dstStart }] in samples.
 */
export function mixPlacements(markers, totalSamples) {
  const placements = [];
  const ordered = markers.length > 0 ? markers : [{ byte: 0, ms: 0 }];
  for (let i = 0; i < ordered.length; i++) {
    const srcStart = Math.floor(ordered[i].byte / PCM_BYTES_PER_16K_SAMPLE);
    const srcEnd = i + 1 < ordered.length
      ? Math.floor(ordered[i + 1].byte / PCM_BYTES_PER_16K_SAMPLE)
      : totalSamples;
    if (srcEnd > srcStart) placements.push({ srcStart, srcEnd, dstStart: Math.round(ordered[i].ms * 16) });
  }
  return placements;
}
