/**
 * 服务端本地文件缓存。
 *
 * 行为契约（PRD §4.2.3）：
 *  - 落盘原子写入（先写 tmp 再 rename），避免读写竞态。
 *  - 文件结构含 metadata，标识来源、生成时间、CDN 同步状态。
 *  - 同一 cache_key 永不过期，靠 content_hash / prompt_version 自然失效。
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '../../config';
import { createLogger } from '../../utils/logger';
import {
  buildCacheKey,
  buildRelativeFilePath,
  type CacheKeyParts,
} from './keys';

const log = createLogger('cache.file');

export interface CacheEntry<T = unknown> {
  cache_key: string;
  work_id: string;
  content_hash: string;
  task_type: string;
  prompt_version: string;
  model: string;
  data: T;
  generated_at: number;
  cdn_synced_at: number | null;
}

async function ensureDir(path: string) {
  await fs.mkdir(dirname(path), { recursive: true });
}

function fullPath(parts: CacheKeyParts) {
  return join(config.cache.dir, buildRelativeFilePath(parts));
}

export async function readFileCache<T>(parts: CacheKeyParts): Promise<CacheEntry<T> | null> {
  const path = fullPath(parts);
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return JSON.parse(raw) as CacheEntry<T>;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    log.warn(`failed to read cache file ${path}`, err);
    return null;
  }
}

export async function writeFileCache<T>(
  parts: CacheKeyParts,
  data: T,
): Promise<CacheEntry<T>> {
  const path = fullPath(parts);
  await ensureDir(path);

  const entry: CacheEntry<T> = {
    cache_key: buildCacheKey(parts),
    work_id: parts.work_id,
    content_hash: parts.content_hash,
    task_type: parts.task_type,
    prompt_version: parts.prompt_version,
    model: parts.model,
    data,
    generated_at: Date.now(),
    cdn_synced_at: null,
  };

  const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  await fs.writeFile(tmp, JSON.stringify(entry, null, 2), 'utf-8');
  await fs.rename(tmp, path);
  return entry;
}

/**
 * 列出所有缓存键（用于 CDN 同步任务或管理工具）。
 */
export async function listCacheEntries(): Promise<CacheKeyParts[]> {
  const root = join(config.cache.dir, 'stories');
  const out: CacheKeyParts[] = [];
  try {
    const workDirs = await fs.readdir(root);
    for (const work of workDirs) {
      const wPath = join(root, work);
      const hashDirs = await fs.readdir(wPath).catch(() => []);
      for (const hash of hashDirs) {
        const hPath = join(wPath, hash);
        const files = await fs.readdir(hPath).catch(() => []);
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const base = file.replace(/\.json$/, '');
          const segments = base.split('_');
          if (segments.length < 3) continue;
          const model = segments.pop()!;
          const prompt_version = segments.pop()!;
          const task_type = segments.join('_');
          out.push({
            work_id: decodeURIComponent(work),
            content_hash: hash,
            task_type: task_type as CacheKeyParts['task_type'],
            prompt_version,
            model,
          });
        }
      }
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('failed to walk cache dir', err);
    }
  }
  return out;
}
