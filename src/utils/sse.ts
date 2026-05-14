/**
 * SSE 工具：把 Express Response 包装成一个发送 SSE 事件的句柄。
 *
 * 协议契约：
 *   - 所有事件都通过 `event: <name>\ndata: <json>\n\n` 发出。
 *   - 客户端通过 fetch + ReadableStream 解析（POST + SSE）。
 */

import type { Response } from 'express';
import type { AiErrorPayload } from '@shared/types/ai';
import type { SseStatusEvent, SseDeltaEvent } from '@shared/types/sse';

export interface SseSender<TFinal> {
  status: (event: SseStatusEvent) => void;
  delta: (event: SseDeltaEvent) => void;
  final: (data: TFinal) => void;
  error: (payload: AiErrorPayload) => void;
  done: () => void;
  closed: () => boolean;
  onClose: (handler: () => void) => void;
}

export function createSseSender<TFinal>(res: Response): SseSender<TFinal> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      res.end();
    } catch {
      /* ignore */
    }
  };

  const handlers: Array<() => void> = [];
  res.on('close', () => {
    closed = true;
    handlers.forEach((h) => {
      try {
        h();
      } catch {
        /* ignore */
      }
    });
  });

  function emit(name: string, payload: unknown) {
    if (closed) return;
    try {
      res.write(`event: ${name}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      closed = true;
    }
  }

  return {
    status: (event) => emit('status', event),
    delta: (event) => emit('delta', event),
    final: (data) => emit('final', data),
    error: (payload) => emit('error', payload),
    done: () => {
      emit('done', {});
      close();
    },
    closed: () => closed,
    onClose: (handler) => handlers.push(handler),
  };
}

/**
 * 把一段文本按字符切分为若干 chunk，模拟流式输出。
 * 在 mock provider 中使用。
 */
export function chunkText(text: string, chunkSize = 14): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}
