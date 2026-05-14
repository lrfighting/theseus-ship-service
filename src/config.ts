import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// 优先加载 .env.local，未覆盖的变量再用 .env 兜底。
// （dotenv 在变量已存在时默认不覆盖。）
for (const f of ['.env.local', '.env']) {
  const p = resolve(process.cwd(), f);
  if (existsSync(p)) loadEnv({ path: p });
}

function envStr(key: string, fallback = ''): string {
  return (process.env[key] ?? fallback).trim();
}

function envNum(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const num = Number(raw);
  return Number.isFinite(num) ? num : fallback;
}

export const config = {
  port: envNum('SERVER_PORT', 4000),

  zhihu: {
    // OAuth 登录凭证
    appId: envStr('ZHIHU_APP_ID'),
    appKey: envStr('ZHIHU_APP_KEY'),
    // 盐言故事开放接口凭证（可能与 OAuth 不是同一套）
    apiAppKey: envStr('ZHIHU_API_APP_KEY', envStr('ZHIHU_APP_KEY')),
    apiAppSecret: envStr('ZHIHU_API_APP_SECRET', envStr('ZHIHU_APP_SECRET')),
    baseUrl: envStr('ZHIHU_OPENAPI_BASE_URL', 'https://openapi.zhihu.com'),
    redirectUri: envStr('ZHIHU_REDIRECT_URI', `http://localhost:${envNum('SERVER_PORT', 4000)}/api/auth/zhihu/callback`),
  },

  ai: {
    provider: (envStr('AI_PROVIDER', 'mock') as 'mock' | 'kimi'),
    kimi: {
      apiKey: envStr('KIMI_API_KEY'),
      baseUrl: envStr('KIMI_BASE_URL', 'https://api.moonshot.cn/v1'),
      model: envStr('KIMI_MODEL', 'kimi-k2-0905-preview'),
      temperature: envNum('KIMI_TEMPERATURE', 0.7),
    },
  },

  cache: {
    dir: resolve(process.cwd(), envStr('CACHE_DIR', './.cache/yyan-ai')),
    cdnBase: envStr('CDN_BASE_URL'),
  },

  prompt: {
    version: 'v1',
  },
} as const;

export type AppConfig = typeof config;
