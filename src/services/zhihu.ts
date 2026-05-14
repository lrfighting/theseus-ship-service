/**
 * 知乎盐言开放接口客户端。
 *
 * - 默认调用真实开放接口（`openapi.zhihu.com/openapi/hackathon_story/*`）。
 * - HMAC-SHA256 签名规则与请求头按《技术方案 V1.0》§3 实现。
 * - 仅当环境变量 `ZHIHU_USE_FIXTURE=1` 时使用本地 fixture，供离线/演示用。
 * - 真实接口失败时直接抛错，不静默回退到 fixture，避免假数据掩盖问题。
 */

import { createHmac } from 'node:crypto';
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

async function fetchListLive(): Promise<StorySummary[]> {
  const data = await callZhihu<StoryListResponse['data']>(
    '/openapi/hackathon_story/list',
  );
  if (!Array.isArray(data)) throw aiUpstream('Zhihu list: data is not array');
  return data;
}

async function fetchDetailLive(
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
// Fixture（仅在 ZHIHU_USE_FIXTURE=1 时启用，开发离线演示）
// ────────────────────────────────────────────────────────────────

const FIXTURE_LIST: StorySummary[] = [
  {
    work_id: 'demo_001',
    title: '秦始皇登月计划',
    artwork:
      'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?auto=format&fit=crop&w=900&q=80',
    tab_artwork:
      'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?auto=format&fit=crop&w=600&q=80',
    description:
      '我一觉醒来，发现自己自带系统穿越到秦始皇身边，凭借兑换功能我立志让大秦登上月球。',
    labels: ['史脑洞', '穿越', '科幻', '爽文'],
  },
];

const FIXTURE_DETAIL: Record<string, Omit<StoryDetail, 'content_hash'>> = {
  demo_001: {
    work_id: 'demo_001',
    chapter_name: '秦始皇登月计划',
    author_avatar: 'https://pic1.zhimg.com/v2-2c2b08efa6f9c8a5f8a0_l.jpg',
    author_name: '六酒',
    labels: ['史脑洞', '穿越', '科幻', '爽文'],
    introduction: '本内容版权为知乎及版权方所有，正在受版权保护中。',
    content: [
      '一觉醒来，我自带系统穿越到秦始皇身边。还可以凭借好感度兑换物品。我直接就是一个滑跪。',
      '"陛下，此乃世界地图！" 秦始皇好感度+100。"陛下，此物可令人上天揽月，成仙人之举！" 秦始皇好感度爆表。"细说上天。"',
      '我抖了抖手中的图纸：登月需要火箭、燃料、轨道计算，还有最重要的——一个能撑住排面的发射台。',
    ].join('\n'),
  },
};

// ────────────────────────────────────────────────────────────────
// 对外接口
// ────────────────────────────────────────────────────────────────

export async function fetchStoryList(): Promise<StorySummary[]> {
  if (USE_FIXTURE) {
    log.info('using ZHIHU_USE_FIXTURE for list');
    return FIXTURE_LIST;
  }
  return fetchListLive();
}

export async function fetchStoryDetail(workId: string): Promise<StoryDetail | null> {
  if (USE_FIXTURE) {
    log.info(`using ZHIHU_USE_FIXTURE for detail ${workId}`);
    const detail = FIXTURE_DETAIL[workId];
    if (!detail) return null;
    return { ...detail, content_hash: contentHash(detail.content) };
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
