import axios from 'axios';

/**
 * Сгенерировать сводку по расшифровке через локальную LLM (Ollama).
 */
export async function summarizeTranscript(transcript) {
  const prompt = buildSummaryPrompt(transcript);
  const url = process.env.OLLAMA_URL || 'http://localhost:11434/api/generate';
  const model = process.env.OLLAMA_MODEL || 'llama3.2';

  const { data } = await axios.post(
    url,
    {
      model,
      prompt,
      stream: false,
      options: {
        temperature: 0.2,
      },
    },
    {
      timeout: 300000,
    },
  );

  return data.response || data.content || '';
}

function buildSummaryPrompt(transcript) {
  return `Ты ассистент на совещаниях. Ниже расшифровка разговора с пометками спикеров. 
Подготовь структурированную сводку на русском языке:

1. Участники и длительность.
2. Краткое содержание — основные темы обсуждения.
3. Ключевые решения.
4. Действия (action items) с ответственными и дедлайнами, если упоминаются.
5. Открытые вопросы.

Расшифровка:
${transcript}

Сводка:`;
}
