#!/usr/bin/env python3
"""
Локальная транскрипция через faster-whisper
"""
import sys
import json
from faster_whisper import WhisperModel

def transcribe(audio_file, language='ru', model_size='base'):
    """Транскрибировать аудио файл"""
    try:
        # Загружаем модель (base быстрая, но менее точная)
        # Можно использовать: tiny, base, small, medium, large-v3
        print(f"Loading Whisper model: {model_size}...", file=sys.stderr)
        model = WhisperModel(model_size, device="cpu", compute_type="int8")
        
        print(f"Transcribing {audio_file}...", file=sys.stderr)
        segments, info = model.transcribe(
            audio_file,
            language=language,
            beam_size=5,
            vad_filter=False,  # ОТКЛЮЧАЕМ фильтр тишины - он слишком агрессивный
            initial_prompt="Это голосовой разговор в Discord.",
        )
        
        # Собираем текст
        text_parts = []
        segment_count = 0
        for segment in segments:
            segment_count += 1
            print(f"  Segment {segment_count}: [{segment.start:.2f}s - {segment.end:.2f}s] {segment.text}", file=sys.stderr)
            text_parts.append(segment.text)
        
        print(f"Total segments: {segment_count}", file=sys.stderr)
        
        text = " ".join(text_parts).strip()
        
        if not text:
            print(f"WARNING: No text transcribed! Audio duration: {info.duration:.2f}s", file=sys.stderr)
        
        # Возвращаем JSON
        result = {
            "text": text,
            "language": info.language,
            "duration": info.duration
        }
        
        print(json.dumps(result, ensure_ascii=False))
        return 0
        
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: whisper_transcribe.py <audio_file> [language] [model_size]", file=sys.stderr)
        sys.exit(1)
    
    audio_file = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 else 'ru'
    model_size = sys.argv[3] if len(sys.argv) > 3 else 'base'
    
    sys.exit(transcribe(audio_file, language, model_size))
