#!/usr/bin/env python3
"""
Локальная транскрипция через faster-whisper -- без внешних API и токенов.

Модель загружается один раз на все файлы созвона. Для каждого файла
возвращаются фразы с таймкодами (секунды от начала файла) -- по ним
src/timeline.js расставляет реплики участников по времени созвона.

Usage: whisper_transcribe.py <language> <model_size> <audio_file> [<audio_file> ...]
Stdout: {"files": {"<audio_file>": {"segments": [{"start", "end", "text"}], "duration"}}}
"""
import json
import sys

from faster_whisper import WhisperModel


def main(argv):
    if len(argv) < 4:
        print(__doc__, file=sys.stderr)
        return 1
    language, model_size, files = argv[1], argv[2], argv[3:]

    print(f"Loading Whisper model: {model_size}...", file=sys.stderr)
    model = WhisperModel(model_size, device="cpu", compute_type="int8")

    out = {}
    for audio_file in files:
        print(f"Transcribing {audio_file}...", file=sys.stderr)
        try:
            segments, info = model.transcribe(
                audio_file,
                language=language,
                beam_size=5,
                # The file is speech only (Discord sends audio while someone
                # talks), but the joins between utterances and background noise
                # still make Whisper "hear" phrases that were never said; VAD
                # drops those stretches. Timestamps stay on the file's timeline.
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 500},
                # Stops one misheard phrase from repeating down the transcript.
                condition_on_previous_text=False,
                initial_prompt="Рабочий созвон команды в Discord.",
                # VAD stitches speech back together, so one segment can span
                # two utterances said a minute apart; per-word times let
                # timeline.js put every word where it was said.
                word_timestamps=True,
            )
            items = []
            for s in segments:
                if not s.text.strip():
                    continue
                item = {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}
                if s.words:
                    # [start, end, word]; the word keeps its leading space
                    item["words"] = [[round(w.start, 2), round(w.end, 2), w.word] for w in s.words]
                items.append(item)
            out[audio_file] = {"segments": items, "duration": round(info.duration, 2)}
            print(f"  {len(items)} segments, {info.duration:.0f}s of audio", file=sys.stderr)
        except Exception as e:  # one bad file shouldn't lose the others
            print(f"Error on {audio_file}: {e}", file=sys.stderr)
            out[audio_file] = {"segments": [], "duration": 0, "error": str(e)}

    print(json.dumps({"files": out}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
