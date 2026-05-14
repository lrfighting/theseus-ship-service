/**
 * SSE 流事件协议，前后端共享。
 *
 * 所有 SSE 端点都遵循以下事件模型：
 *   event: status   data: SseStatusEvent
 *   event: delta    data: SseDeltaEvent
 *   event: final    data: 业务结果 (BranchContinuationResult / ExtraResult)
 *   event: error    data: AiErrorPayload
 *   event: done     data: {}
 *
 * 客户端必须按事件名分发；浏览器原生 EventSource 只支持 GET，
 * 因此我们用 fetch + ReadableStream 自行实现（POST + SSE 解析）。
 */

import type { AiErrorPayload } from './ai';

export type SseStatusEvent =
  | { status: 'queued'; upstream_ready: number; upstream_total: number }
  | { status: 'pending'; task_id: string }
  | { status: 'generating'; task_id: string }
  | { status: 'cancelling'; task_id: string };

export interface SseDeltaEvent {
  text: string;
  /** AI 续写场景下，标识增量属于第几段落（可选） */
  paragraph_id?: string;
}

export type SseEventName = 'status' | 'delta' | 'final' | 'error' | 'done';

export interface SseEventPayloadMap {
  status: SseStatusEvent;
  delta: SseDeltaEvent;
  // final / error 的 payload 由各端点自行定义
  final: unknown;
  error: AiErrorPayload;
  done: Record<string, never>;
}

export interface SseEnvelope<TFinal> {
  status: SseStatusEvent[];
  deltas: SseDeltaEvent[];
  final?: TFinal;
  error?: AiErrorPayload;
  done: boolean;
}
