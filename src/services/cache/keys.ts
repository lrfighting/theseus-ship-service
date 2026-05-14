/**
 * AI 缓存键和文件路径约定（V1.3 PRD §4.2.1 / §4.2.3）。
 *
 * 单个缓存键由：work_id + content_hash + task_type + prompt_version + model
 * 五个维度组成；用户级数据（branch / extra / impact）不进入共享缓存，由前端会话存储。
 */

import type { BackgroundTaskType } from '@shared/types/ai';

export interface CacheKeyParts {
  work_id: string;
  content_hash: string;
  task_type: BackgroundTaskType;
  prompt_version: string;
  model: string;
}

export function buildCacheKey(parts: CacheKeyParts): string {
  return `ai_${parts.task_type}_${parts.work_id}_${parts.content_hash}_${parts.prompt_version}_${parts.model}`;
}

/**
 * 文件相对路径：
 *   stories/{work_id}/{content_hash}/{task_type}_{prompt_version}_{model}.json
 */
export function buildRelativeFilePath(parts: CacheKeyParts): string {
  return [
    'stories',
    encodeURIComponent(parts.work_id),
    parts.content_hash,
    `${parts.task_type}_${parts.prompt_version}_${parts.model}.json`,
  ].join('/');
}

/**
 * CDN 的完整路径：
 *   {CDN_BASE_URL}/yyan-ai-cache/{relative}
 */
export function buildCdnPath(cdnBase: string, parts: CacheKeyParts): string {
  return `${cdnBase.replace(/\/$/, '')}/yyan-ai-cache/${buildRelativeFilePath(parts)}`;
}
