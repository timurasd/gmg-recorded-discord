import Anthropic from '@anthropic-ai/sdk';

// One request per meeting. Haiku is enough for a meeting summary and costs
// well under a cent for an hour of talk (Andrew, 2026-10-19). SUMMARY_MODEL
// overrides it; the old CLAUDE_MODEL setting is no longer read.
const DEFAULT_MODEL = 'claude-haiku-5-5';

const SYSTEM_PROMPT = `Ты делаешь сводку рабочего созвона по автоматической расшифровке. В расшифровке бывают ошибки распознавания: опечатки, искажённые имена и термины. Восстанавливай смысл по контексту и не выдумывай того, чего в разговоре не было.

Пиши на русском, обычным текстом без Markdown: без решёток, звёздочек и таблиц. Списки — строками, начинающимися с «— ». Разделы, по которым в разговоре ничего не было, пропускай.

Разделы:
Кратко — 2–3 предложения, о чём был созвон.
Темы — что обсуждали, по пунктам.
Решения — что решили.
Задачи — кто что делает и к какому сроку, если это прозвучало.
Открытые вопросы — что осталось нерешённым.`;

// Created on first use, after dotenv has loaded ANTHROPIC_API_KEY.
let client = null;

/**
 * Сводка по расшифровке через Claude API.
 * Returns { summary } or { summary: null, error } -- a failed summary must not
 * stop the transcript from being delivered.
 */
export async function summarizeTranscript(transcript, { participants = [], durationText = '' } = {}) {
  const model = process.env.SUMMARY_MODEL || DEFAULT_MODEL;
  console.log(`🤖 Generating summary via Claude (${model})...`);

  try {
    client ??= new Anthropic({ maxRetries: 3, timeout: 120_000 });
    const response = await client.messages.create({
      model,
      max_tokens: 8000,
      output_config: { effort: 'medium' },
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `Участники: ${participants.join(', ') || 'неизвестно'}\nДлительность: ${durationText}\n\nРасшифровка:\n${transcript}`,
      }],
    });

    if (response.stop_reason === 'refusal') {
      const category = response.stop_details?.category || 'без категории';
      return { summary: null, error: `модель отказалась делать сводку (${category})` };
    }
    const summary = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (!summary) return { summary: null, error: 'модель вернула пустой ответ' };

    console.log(`✅ Summary: ${summary.length} chars, tokens in/out ${response.usage.input_tokens}/${response.usage.output_tokens}`);
    if (response.stop_reason === 'max_tokens') {
      return { summary: summary + '\n\n(сводка обрезана по лимиту длины)' };
    }
    return { summary };
  } catch (error) {
    let reason;
    if (error instanceof Anthropic.AuthenticationError) reason = 'неверный API-ключ Anthropic';
    else if (error instanceof Anthropic.PermissionDeniedError) reason = 'у API-ключа нет доступа к модели';
    else if (error instanceof Anthropic.RateLimitError) reason = 'лимит запросов Anthropic, попробуйте позже';
    else if (error instanceof Anthropic.BadRequestError) reason = `запрос отклонён: ${error.message}`;
    else if (error instanceof Anthropic.APIError) reason = `ошибка API ${error.status ?? ''}: ${error.message}`;
    else reason = error.message;
    console.error('❌ Summary failed:', reason);
    return { summary: null, error: reason };
  }
}
