/**
 * Kimi (Moonshot AI / Kimi Code) Provider 实现。
 *
 * 当前对接的是 Anthropic Messages API 兼容格式（Kimi Code 专用）：
 *   POST {base}/messages
 *   Headers: x-api-key, anthropic-version
 *   Body: { model, max_tokens, messages, temperature, stream }
 *
 * 流式响应为 SSE，事件类型按 Anthropic 规范：
 *   event: content_block_delta
 *   data: { type:"content_block_delta", delta:{ type:"text_delta", text:"..." } }
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

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicMessageResponse {
  id: string;
  type: string;
  role: string;
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

interface AnthropicStreamEvent {
  type: string;
  delta?: {
    type: string;
    text?: string;
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

  // Anthropic Messages API 要求 system prompt 放在顶级 system 字段，
  // messages 数组中只能有 user / assistant 交替。
  const systemTexts: string[] = [];
  const apiMessages = messages
    .filter((m) => {
      if (m.role === 'system') {
        systemTexts.push(m.content);
        return false;
      }
      return true;
    })
    .map((m) => ({ role: m.role, content: m.content }));

  const body: Record<string, unknown> = {
    model: opts.model ?? kimi.model,
    max_tokens: opts.max_tokens ?? 40960,
    messages: apiMessages,
    temperature: opts.temperature ?? kimi.temperature,
    ...(systemTexts.length ? { system: systemTexts.join('\n\n') } : {}),
    ...(stream ? { stream: true } : {}),
  };

  let resp: Response;
  try {
    resp = await fetch(`${kimi.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': kimi.apiKey,
        'anthropic-version': '2023-06-01',
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
    log.warn(`Kimi non-2xx: ${resp.status} ${text}`);
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
    const data = (await resp.json()) as AnthropicMessageResponse;
    const text = (data.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text ?? '')
      .join('')
      .trim();
    return {
      text,
      model: data.model,
      prompt_tokens: data.usage?.input_tokens,
      completion_tokens: data.usage?.output_tokens,
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

      let currentEvent = '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          currentEvent = '';
          continue;
        }
        if (trimmed.startsWith('event:')) {
          currentEvent = trimmed.slice(6).trim();
          continue;
        }
        if (trimmed.startsWith('data:')) {
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') {
            yield { text: '', done: true };
            return;
          }
          try {
            const event = JSON.parse(data) as AnthropicStreamEvent;
            if (
              currentEvent === 'content_block_delta' &&
              event.type === 'content_block_delta' &&
              event.delta?.text
            ) {
              yield { text: event.delta.text, done: false };
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
