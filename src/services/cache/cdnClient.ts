/**
 * CDN 缓存读取（HTTP GET 静态对象）。
 *
 * P0 默认未配置 CDN（CDN_BASE_URL 为空），所有调用返回 null，回退到文件缓存。
 * 上线时配置 CDN_BASE_URL 后，本模块的 read 即生效，配合 dailySync.ts 完成同步。
 */

import { config } from '../../config';
import { createLogger } from '../../utils/logger';
import { buildCdnPath, type CacheKeyParts } from './keys';
import type { CacheEntry } from './fileCache';

const log = createLogger('cache.cdn');

export async function readCdnCache<T>(parts: CacheKeyParts): Promise<CacheEntry<T> | null> {
  if (!config.cache.cdnBase) return null;

  const url = buildCdnPath(config.cache.cdnBase, parts);
  try {
    const resp = await fetch(url, { method: 'GET' });
    if (!resp.ok) {
      if (resp.status !== 404) {
        log.warn(`CDN fetch failed: ${resp.status} ${url}`);
      }
      return null;
    }
    const data = (await resp.json()) as CacheEntry<T>;
    return data;
  } catch (err) {
    log.warn(`CDN read error for ${url}`, err);
    return null;
  }
}
