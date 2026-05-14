/**
 * AI Provider 抽象（PRD §5.1.2）。
 *
 * Provider 只关心"输入 messages → 输出文本/流"，
 * 业务编排（缓存命中、Prompt 构造、JSON 解析、SSE 切分）由上层 services 完成。
 */

import type { ChatMessage } from './prompts/builders';

export interface ChatCompletionOptions {
  model?: string;
  temperature?: number;
  /** 强制 JSON 输出（Moonshot 兼容） */
  json?: boolean;
  /** 上下文窗口提示（仅参考） */
  max_tokens?: number;
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  text: string;
  model: string;
  prompt_tokens?: number;
  completion_tokens?: number;
}

export interface StreamChunk {
  text: string;
  done: boolean;
}

export interface StoryAIProvider {
  /** 名称，用于落缓存键 */
  readonly name: string;
  /** 默认模型 ID */
  readonly defaultModel: string;

  /** 同步补全（背景任务用） */
  complete(messages: ChatMessage[], opts?: ChatCompletionOptions): Promise<ChatCompletionResult>;

  /**
   * 流式补全（分支续写、番外用）。
   * 返回 AsyncIterable<StreamChunk>；调用方负责积累文本与解析最终 JSON。
   */
  stream(
    messages: ChatMessage[],
    opts?: ChatCompletionOptions,
  ): AsyncIterable<StreamChunk>;
}
