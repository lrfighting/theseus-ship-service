/**
 * 三级缓存外观（PRD §4.2.2）：
 *
 *   [1] 内存 LRU（本进程）
 *   [2] CDN 静态对象
 *   [3] 服务端本地文件
 *
 * 三级都 miss 时返回 null，由上层触发实时生成。
 * 写入只落第 1 / 第 3 级；第 2 级由按日同步任务异步上传。
 */

import { createLogger } from '../../utils/logger';
import { readFileCache, writeFileCache, type CacheEntry } from './fileCache';
import { readCdnCache } from './cdnClient';
import { buildCacheKey, type CacheKeyParts } from './keys';

const log = createLogger('cache');

const MEM_LIMIT = 200;
const memCache = new Map<string, CacheEntry<unknown>>();

function memSet<T>(key: string, entry: CacheEntry<T>) {
  if (memCache.size >= MEM_LIMIT) {
    const firstKey = memCache.keys().next().value;
    if (firstKey !== undefined) memCache.delete(firstKey);
  }
  memCache.set(key, entry as CacheEntry<unknown>);
}

export interface CacheReadResult<T> {
  entry: CacheEntry<T>;
  source: 'memory' | 'file' | 'cdn';
}

export async function readCache<T>(parts: CacheKeyParts): Promise<CacheReadResult<T> | null> {
  const cacheKey = buildCacheKey(parts);

  const mem = memCache.get(cacheKey) as CacheEntry<T> | undefined;
  if (mem) return { entry: mem, source: 'memory' };

  const cdn = await readCdnCache<T>(parts);
  if (cdn) {
    memSet(cacheKey, cdn);
    return { entry: cdn, source: 'cdn' };
  }

  const file = await readFileCache<T>(parts);
  if (file) {
    memSet(cacheKey, file);
    return { entry: file, source: 'file' };
  }

  return null;
}

export async function writeCache<T>(
  parts: CacheKeyParts,
  data: T,
): Promise<CacheEntry<T>> {
  const entry = await writeFileCache(parts, data);
  memSet(entry.cache_key, entry);
  log.debug(`cache write: ${entry.cache_key}`);
  return entry;
}

export type { CacheEntry, CacheKeyParts };
