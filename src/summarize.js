import OpenAI from 'openai';

// One request per meeting, on the OpenAI key GMG already uses for the wiki and
// the dashboard (Andrew, 2026-10-19; the Anthropic key in .env was dead).
// A cheap model is enough for a meeting summary -- a fraction of a cent per
// hour of talk. SUMMARY_MODEL overrides it.
const DEFAULT_MODEL = 'gpt-4o-mini';

const SYSTEM_PROMPT = `Ты делаешь сводку рабочего созвона по автоматической расшифровке. В расшифровке бывают ошибки распознавания: опечатки, искажённые имена и термины. Восстанавливай смысл по контексту и не выдумывай того, чего в разговоре не было.

Пиши на русском, обычным текстом без Markdown: без решёток, звёздочек и таблиц. Списки — строками, начинающимися с «— ». Разделы, по которым в разговоре ничего не было, пропускай.

Разделы:
Кратко — 2–3 предложения, о чём был созвон.
Темы — что обсуждали, по пунктам.
Решения — что решили.
Задачи — кто что делает и к какому сроку, если это прозвучало.
Открытые вопросы — что осталось нерешённым.`;

// Created on first use, after dotenv has loaded OPENAI_API_KEY.
let client = null;

/**
 * Сводка по расшифровке.
 * Returns { summary } or { summary: null, error } -- a failed summary must not
 * stop the transcript from being delivered.
 */
export async function summarizeTranscript(transcript, { participants = [], durationText = '' } = {}) {
  const model = process.env.SUMMARY_MODEL || DEFAULT_MODEL;
  console.log(`🤖 Generating summary via OpenAI (${model})...`);

  try {
    client ??= new OpenAI({ maxRetries: 3, timeout: 120_000 });
    const response = await client.chat.completions.create({
      model,
      max_tokens: 3000,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Участники: ${participants.join(', ') || 'неизвестно'}\nДлительность: ${durationText}\n\nРасшифровка:\n${transcript}`,
        },
      ],
    });

    const choice = response.choices?.[0];
    if (choice?.finish_reason === 'content_filter') {
      return { summary: null, error: 'модель отказалась делать сводку (фильтр контента)' };
    }
    const summary = String(choice?.message?.content || '').trim();
    if (!summary) return { summary: null, error: 'модель вернула пустой ответ' };

    console.log(`✅ Summary: ${summary.length} chars, tokens in/out ${response.usage?.prompt_tokens}/${response.usage?.completion_tokens}`);
    if (choice.finish_reason === 'length') {
      return { summary: summary + '\n\n(сводка обрезана по лимиту длины)' };
    }
    return { summary };
  } catch (error) {
    let reason;
    if (error instanceof OpenAI.AuthenticationError) reason = 'неверный API-ключ OpenAI';
    else if (error instanceof OpenAI.PermissionDeniedError) reason = 'у API-ключа OpenAI нет доступа к модели';
    else if (error instanceof OpenAI.RateLimitError) reason = 'лимит или баланс OpenAI исчерпан, попробуйте позже';
    else if (error instanceof OpenAI.BadRequestError) reason = `запрос отклонён: ${error.message}`;
    else if (error instanceof OpenAI.APIError) reason = `ошибка API ${error.status ?? ''}: ${error.message}`;
    else reason = error.message;
    console.error('❌ Summary failed:', reason);
    return { summary: null, error: reason };
  }
}
