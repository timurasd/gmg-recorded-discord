/**
 * Pipeline - turns a recorded session into a transcript and a summary and
 * delivers them. Used after !leave and for sessions recovered after a crash.
 *
 * Kept on disk afterwards (the daily cleanup removes the session after 7
 * days): 16 kHz WAV per user + utterance markers (for !audio), transcript,
 * summary. The raw 48 kHz PCM is deleted -- ~690 MB per hour of speech.
 */

import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { listChunkFiles, concatenateChunkFilesWithGaps, markersPath, wavMarkersPath, recoverIncompleteChunks } from './recorder/chunk-writer.js';
import { updateSessionFile } from './recorder/session-manager.js';
import { transcribeSession } from './transcribe.js';
import { summarizeTranscript } from './summarize.js';
import { parseMarkers, formatTranscript, markersWithGaps, UTTERANCE_GAP_BYTES } from './timeline.js';
import { sendResults, updateProgress, formatDuration, formatMoscowTime } from './delivery.js';

/**
 * Summary + transcript of every meeting, kept for good in archive/ (the
 * session folder with the audio goes after 7 days). Andrew wants the
 * transcripts readable later, on request, to fill the project knowledge base
 * (2026-10-22). One text file per meeting, ~100 KB.
 */
export async function archiveText({ startTime, summary, summaryError, transcript }) {
  try {
    const dir = process.env.ARCHIVE_DIR || './archive';
    await fs.mkdir(dir, { recursive: true });
    // Moscow wall clock in the name: call_2026-10-21_14-05.txt
    const stamp = new Date(startTime + 3 * 3600_000).toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
    let file = path.join(dir, `call_${stamp}.txt`);
    if (existsSync(file)) file = path.join(dir, `call_${stamp}_${Date.now()}.txt`);
    const summaryBlock = summary || `(сводки нет: ${summaryError || 'неизвестная ошибка'})`;
    await fs.writeFile(file, `СВОДКА\n\n${summaryBlock}\n\n\nРАСШИФРОВКА\n\n${transcript}`, 'utf-8');
    console.log(`[Pipeline] Archived to ${file}`);
  } catch (err) {
    console.error('[Pipeline] Archive write failed:', err.message); // never blocks delivery
  }
}

/**
 * users: [{ userId, name }]; chunks are read from <sessionDir>/chunks/<userId>.
 * Throws when there is nothing to transcribe; the caller reports it.
 */
export async function processSession({ sessionId, sessionDir, startTime, endTime, users, participants, interrupted = false, progressMessageId = null }) {
  const durationSec = Math.max(1, Math.round((endTime - startTime) / 1000));
  // Counted so recovery stops re-running a job that keeps killing the bot.
  const before = updateSessionFile(sessionDir, {});
  updateSessionFile(sessionDir, { state: 'processing', endTime, processingAttempts: (before?.processingAttempts || 0) + 1 });

  try {
    // A chunk still open when the connection dropped or the bot crashed is
    // ".recording" -- mark it partial so its audio is included.
    await recoverIncompleteChunks(sessionDir);

    const prepared = [];
    for (const user of users) {
      const chunks = listChunkFiles(path.join(sessionDir, 'chunks', user.userId));
      if (chunks.length === 0) continue;
      const pcmFile = path.join(sessionDir, `${user.userId}.pcm`);
      const markersFile = markersPath(sessionDir, user.userId);
      const markers = existsSync(markersFile) ? parseMarkers(await fs.readFile(markersFile, 'utf-8')) : [];
      // A second of silence between utterances, so Whisper splits there; the
      // shifted markers match the resulting file (and the WAV kept for !audio).
      await concatenateChunkFilesWithGaps(chunks, pcmFile, markers, UTTERANCE_GAP_BYTES);
      const fileMarkers = markersWithGaps(markers);
      await fs.writeFile(wavMarkersPath(sessionDir, user.userId), fileMarkers.map((m) => JSON.stringify(m)).join('\n') + '\n');
      prepared.push({ userId: user.userId, name: user.name, pcmFile, markers: fileMarkers });
    }
    if (prepared.length === 0) throw new Error('Нет записанного звука.');

    const { lines } = await transcribeSession(prepared, sessionDir, async (percent, name) => {
      await updateProgress(progressMessageId, percent, `🎤 Расшифровываю: ${name}`);
    });

    const speakers = [...new Set(lines.map((l) => l.speaker))];
    const header = [
      `Созвон ${formatMoscowTime(startTime)}, ${formatDuration(durationSec)}`,
      `Участники: ${(participants.length ? participants : speakers).join(', ')}`,
    ];
    if (interrupted) header.push('Запись прервалась — расшифровано то, что успело записаться.');
    const transcript = `${header.join('\n')}\n\n${formatTranscript(lines)}\n`;
    const transcriptPath = path.join(sessionDir, 'transcript.txt');
    await fs.writeFile(transcriptPath, transcript, 'utf-8');

    await updateProgress(progressMessageId, 92, '🤖 Делаю сводку...');
    const { summary, error: summaryError } = await summarizeTranscript(formatTranscript(lines), {
      participants: speakers,
      durationText: formatDuration(durationSec),
    });
    if (summary) await fs.writeFile(path.join(sessionDir, 'summary.txt'), summary, 'utf-8');
    await archiveText({ startTime, summary, summaryError, transcript });

    await sendResults({
      transcriptPath,
      summary,
      summaryError,
      participants: speakers,
      durationSec,
      startTime,
      interrupted,
      progressMessageId,
    });

    // Raw audio is no longer needed: the WAVs + markers rebuild the mix for !audio.
    await fs.rm(path.join(sessionDir, 'chunks'), { recursive: true, force: true });
    for (const p of prepared) await fs.rm(p.pcmFile, { force: true });

    updateSessionFile(sessionDir, {
      state: 'completed',
      endTime,
      durationSec,
      speakers,
      summaryOk: Boolean(summary),
      summaryError: summaryError || null,
      interrupted,
    });
    console.log(`[Pipeline] Session ${sessionId} done: ${lines.length} lines, summary ${summary ? 'ok' : 'failed'}`);
    return { lines: lines.length, summaryOk: Boolean(summary) };
  } catch (err) {
    updateSessionFile(sessionDir, { state: 'failed', error: err.message });
    throw err;
  }
}
