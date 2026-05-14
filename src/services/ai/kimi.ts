/**
 * Moonshot (Kimi) Provider — OpenAI 兼容格式。
 *
 * 端点: POST {baseUrl}/chat/completions
 * Headers: Authorization: Bearer {apiKey}
 * Body:   { model, messages, temperature, stream }
 */

import { config } from '../../config';
import { aiUpstream, aiTimeout } from '../../utils/errors';
import { createLogger } from '../../utils/logger';
import type {
  ChatCompletionOptions,
  ChatCompletionResult,
  StoryAIProvider,
  StreamChunk,
} from './provider';
import type { ChatMessage } from './prompts/builders';

const log = createLogger('ai.kimi');

interface OpenAIChoice {
  message?: {
    role: string;
    content: string | null;
  };
  delta?: {
    role?: string;
    content?: string | null;
  };
  finish_reason?: string | null;
}

interface OpenAIResponse {
  id: string;
  object: string;
  model: string;
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

async function callKimi(
  messages: ChatMessage[],
  opts: ChatCompletionOptions,
  stream: boolean,
): Promise<Response> {
  const { kimi } = config.ai;
  if (!kimi.apiKey) {
    throw aiUpstream('KIMI_API_KEY is not configured');
  }

  const body: Record<string, unknown> = {
    model: opts.model ?? kimi.model,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    temperature: opts.temperature ?? kimi.temperature,
    max_tokens: opts.max_tokens ?? 40960,
    ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
    ...(stream ? { stream: true } : {}),
  };

  let resp: Response;
  try {
    resp = await fetch(`${kimi.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${kimi.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw aiTimeout('Kimi request aborted');
    throw aiUpstream(`Kimi network error: ${(err as Error).message}`);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    log.warn(`Kimi non-2xx: ${resp.status} ${text.slice(0, 240)}`);
    let detail = text;
    try {
      const json = JSON.parse(text);
      detail = json.error?.message ?? json.message ?? text;
    } catch {
      /* keep raw text */
    }
    throw aiUpstream(`Kimi 请求失败 (${resp.status}): ${detail || '未知错误'}`, { body: text });
  }

  return resp;
}

export const kimiProvider: StoryAIProvider = {
  name: 'kimi',
  defaultModel: config.ai.kimi.model,

  async complete(messages, opts = {}): Promise<ChatCompletionResult> {
    const resp = await callKimi(messages, opts, false);
    const data = (await resp.json()) as OpenAIResponse;
    const text = data.choices?.[0]?.message?.content ?? '';
    return {
      text,
      model: data.model,
      prompt_tokens: data.usage?.prompt_tokens,
      completion_tokens: data.usage?.completion_tokens,
    };
  },

  async *stream(messages, opts = {}): AsyncIterable<StreamChunk> {
    const resp = await callKimi(messages, opts, true);
    const reader = resp.body?.getReader();
    if (!reader) throw aiUpstream('Kimi: no stream body');

    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;
        if (trimmed === 'data: [DONE]') {
          yield { text: '', done: true };
          return;
        }
        if (trimmed.startsWith('data:')) {
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          try {
            const event = JSON.parse(data) as OpenAIResponse;
            const delta = event.choices?.[0]?.delta;
            if (delta?.content) {
              yield { text: delta.content, done: false };
            }
          } catch (err) {
            log.warn('Kimi: failed to parse SSE chunk', { data, err });
          }
        }
      }
    }
    yield { text: '', done: true };
  },
};
