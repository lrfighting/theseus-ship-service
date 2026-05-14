/**
 * 通用基础类型，供前后端共享。
 */

export interface ApiSuccess<T> {
  data: T;
  cached_at?: number;
  source?: 'memory' | 'file' | 'cdn' | 'live' | 'browser';
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export type ModelId = string;

export type PromptVersion = string;

export type GenreTemplateKey =
  | 'prompt_template_romance'
  | 'prompt_template_suspense'
  | 'prompt_template_history_brain'
  | 'prompt_template_realistic'
  | 'prompt_template_general';

export interface CacheMeta {
  cache_key: string;
  generated_at: number;
  source: 'memory' | 'file' | 'cdn' | 'live';
  prompt_version: PromptVersion;
  model: ModelId;
}
