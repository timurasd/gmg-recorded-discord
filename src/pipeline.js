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
 * users: [{ userId, name }]; chunks are read from <sessionDir>/chunks/<userId>.
 * Throws when there is nothing to transcribe; the caller reports it.
 */
export async function processSession({ sessionId, sessionDir, startTime, endTime, users, participants, interrupted = false, progressMessageId = null }) {
  const durationSec = Math.max(1, Math.round((endTime - startTime) / 1000));
  updateSessionFile(sessionDir, { state: 'processing', endTime });

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
