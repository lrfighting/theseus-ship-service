/**
 * 知乎盐言开放接口客户端。
 *
 * - 默认调用真实开放接口（`openapi.zhihu.com/openapi/hackathon_story/*`）。
 * - HMAC-SHA256 签名规则与请求头按《技术方案 V1.0》§3 实现。
 * - 当环境变量 `ZHIHU_USE_FIXTURE=1` 时从 `mocks/` 目录读取本地文件，供离线/演示用。
 *   运行 `npm run init-mock` 可预取并保存真实数据到该目录。
 * - 真实接口失败时直接抛错，不静默回退到 fixture，避免假数据掩盖问题。
 */

import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { resolve } from 'node:path';
import { config } from '../config';
import { contentHash } from '../utils/hash';
import { aiUpstream, badRequest, notFound } from '../utils/errors';
import { createLogger } from '../utils/logger';
import type { StoryDetail, StorySummary } from '@shared/types/story';

const log = createLogger('zhihu');

const USE_FIXTURE = (process.env.ZHIHU_USE_FIXTURE ?? '').trim() === '1';

// ────────────────────────────────────────────────────────────────
// 签名 & headers
// ────────────────────────────────────────────────────────────────

type ZhihuAuthHeaders = Record<string, string>;

function createAuthHeaders(extraInfo = ''): ZhihuAuthHeaders {
  const appKey = config.zhihu.apiAppKey;
  const appSecret = config.zhihu.apiAppSecret;
  if (!appKey || !appSecret) {
    throw aiUpstream(
      'Zhihu API credentials missing: 请在环境变量中配置 ZHIHU_API_APP_KEY / ZHIHU_API_APP_SECRET',
    );
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const logId = `request_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const signStr = `app_key:${appKey}|ts:${timestamp}|logid:${logId}|extra_info:${extraInfo}`;
  const sign = createHmac('sha256', appSecret).update(signStr).digest('base64');

  return {
    'X-App-Key': appKey,
    'X-Timestamp': timestamp,
    'X-Log-Id': logId,
    'X-Sign': sign,
    'X-Extra-Info': extraInfo,
  };
}

// ────────────────────────────────────────────────────────────────
// 响应类型
// ────────────────────────────────────────────────────────────────

interface ZhihuOpenApiResponse<T> {
  status: number;
  msg: string;
  data: T;
}

type StoryListResponse = ZhihuOpenApiResponse<StorySummary[] | null>;
type StoryDetailResponse = ZhihuOpenApiResponse<Omit<StoryDetail, 'content_hash'> | null>;

// ────────────────────────────────────────────────────────────────
// 真实接口实现
// ────────────────────────────────────────────────────────────────

async function callZhihu<T>(path: string, search?: Record<string, string>): Promise<T> {
  const url = new URL(`${config.zhihu.baseUrl}${path}`);
  if (search) {
    for (const [k, v] of Object.entries(search)) url.searchParams.set(k, v);
  }

  const headers = createAuthHeaders();
  log.debug(`GET ${url.toString()}  (logId=${headers['X-Log-Id']})`);

  let resp: Response;
  try {
    resp = await fetch(url, { method: 'GET', headers });
  } catch (err) {
    throw aiUpstream(`Zhihu network error: ${(err as Error).message}`);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    log.warn(`Zhihu HTTP ${resp.status} ${url.pathname}: ${text.slice(0, 240)}`);
    throw aiUpstream(`Zhihu HTTP ${resp.status}`, { body: text });
  }

  const payload = (await resp.json()) as ZhihuOpenApiResponse<T>;
  if (payload.status !== 0) {
    log.warn(`Zhihu status=${payload.status} msg=${payload.msg}`);
    throw aiUpstream(payload.msg || `Zhihu status=${payload.status}`);
  }
  return payload.data as T;
}

export async function fetchListLive(): Promise<StorySummary[]> {
  const data = await callZhihu<StoryListResponse['data']>(
    '/openapi/hackathon_story/list',
  );
  if (!Array.isArray(data)) throw aiUpstream('Zhihu list: data is not array');
  return data;
}

export async function fetchDetailLive(
  workId: string,
): Promise<Omit<StoryDetail, 'content_hash'>> {
  if (!workId) throw badRequest('work_id is required');
  const data = await callZhihu<StoryDetailResponse['data']>(
    '/openapi/hackathon_story/detail',
    { work_id: workId },
  );
  if (!data) throw notFound('story');
  return data;
}

// ────────────────────────────────────────────────────────────────
// Mock 文件读取（ZHIHU_USE_FIXTURE=1 时启用）
// 运行 `npm run init-mock` 可预取并保存真实数据到 mocks/ 目录
// ────────────────────────────────────────────────────────────────

const MOCK_DIR = resolve(process.cwd(), 'mocks');

async function loadMockList(): Promise<StorySummary[]> {
  const path = resolve(MOCK_DIR, 'zhihu-list.json');
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return JSON.parse(raw) as StorySummary[];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw aiUpstream(
        'Mock 文件不存在：请先运行 `npm run init-mock` 预取数据（mocks/zhihu-list.json）',
      );
    }
    throw aiUpstream(`Failed to read mock list: ${(err as Error).message}`);
  }
}

async function loadMockDetail(workId: string): Promise<StoryDetail | null> {
  const path = resolve(MOCK_DIR, 'zhihu-details', `${workId}.json`);
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return JSON.parse(raw) as StoryDetail;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw aiUpstream(`Failed to read mock detail for ${workId}: ${(err as Error).message}`);
  }
}

// ────────────────────────────────────────────────────────────────
// 对外接口
// ────────────────────────────────────────────────────────────────

export async function fetchStoryList(): Promise<StorySummary[]> {
  if (USE_FIXTURE) {
    log.info('ZHIHU_USE_FIXTURE=1: loading story list from mocks/zhihu-list.json');
    return loadMockList();
  }
  return fetchListLive();
}

export async function fetchStoryDetail(workId: string): Promise<StoryDetail | null> {
  if (USE_FIXTURE) {
    log.info(`ZHIHU_USE_FIXTURE=1: loading detail for ${workId} from mocks/`);
    return loadMockDetail(workId);
  }
  try {
    const detail = await fetchDetailLive(workId);
    return { ...detail, content_hash: contentHash(detail.content) };
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

/** 测试钩子：仅在 jest/单元测试里使用 */
export const __testing = { createAuthHeaders };

