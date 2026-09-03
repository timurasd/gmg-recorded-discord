import Anthropic from '@anthropic-ai/sdk';

/**
 * Сгенерировать сводку по расшифровке через Claude API.
 */
export async function summarizeTranscript(transcript) {
  const prompt = buildSummaryPrompt(transcript);
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';

  console.log(`🤖 Generating summary via Claude (${model})...`);

  const message = await anthropic.messages.create({
    model,
    max_tokens: 2048,
    temperature: 0.2,
    messages: [{
      role: 'user',
      content: prompt
    }]
  });

  console.log(`✅ Summary generated, length: ${message.content[0].text.length} chars`);
  return message.content[0].text;
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
