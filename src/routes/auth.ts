/**
 * 知乎 OAuth 2.0 授权码模式。
 *
 * 流程：
 *  1. 前端点击登录 → GET /auth/zhihu/login → 302 到知乎授权页
 *  2. 用户授权后 → 知乎 302 到 /auth/zhihu/callback?code=xxx
 *  3. 后端用 code 换 access_token → 获取用户信息 → 写 session cookie
 *  4. 后端 302 回前端首页
 */

import { Router } from 'express';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { createSession, destroySession, getSession } from '../services/session';
import type { ZhihuUser } from '../services/session';

const log = createLogger('route.auth');
export const authRouter = Router();

const isProduction = process.env.NODE_ENV === 'production';

/** 跨域 cookie 配置：生产环境需要 sameSite='none' + secure */
function cookieOpts(): {
  httpOnly: boolean;
  maxAge: number;
  sameSite: 'none' | 'lax';
  secure: boolean;
  path: string;
} {
  return {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 天
    sameSite: isProduction ? 'none' : 'lax',
    secure: isProduction,
    path: '/',
  };
}

// ────────────────────────────────────────────────────────────
// 1. 引导用户到知乎授权页
// ────────────────────────────────────────────────────────────

authRouter.get('/zhihu/login', (req, res) => {
  const redirectUri = encodeURIComponent(config.zhihu.redirectUri);
  const appId = encodeURIComponent(config.zhihu.appId);
  // state 用于回调后跳回前端（同时防 CSRF）
  const clientUrl = (req.query.redirect as string | undefined)
    || req.headers.referer
    || (process.env.FRONTEND_URL || 'http://localhost:5173/');
  const state = encodeURIComponent(clientUrl);
  const authUrl = `https://openapi.zhihu.com/authorize?redirect_uri=${redirectUri}&app_id=${appId}&response_type=code&state=${state}`;
  res.redirect(authUrl);
});

// ────────────────────────────────────────────────────────────
// 2. 知乎回调：code → access_token → 用户信息 → session
// ────────────────────────────────────────────────────────────

authRouter.get('/zhihu/callback', async (req, res) => {
  // 知乎文档写参数名是 code，但实际可能是 authorization_code，两个都兼容
  const code = (req.query.code ?? req.query.authorization_code) as string | undefined;
  if (!code) {
    res.status(400).json({ error: { code: 'MISSING_CODE', message: '缺少 authorization_code' } });
    return;
  }

  try {
    // 2.1 用 code 换 access_token
    const tokenResp = await fetch(`${config.zhihu.baseUrl}/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        app_id: config.zhihu.appId,
        app_key: config.zhihu.appKey,
        grant_type: 'authorization_code',
        redirect_uri: config.zhihu.redirectUri,
        code,
      }),
    });

    const tokenData = await tokenResp.json() as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
      code?: number;
      data?: string;
    };

    if (!tokenData.access_token) {
      log.warn('zhihu token exchange failed', tokenData);
      res.status(400).json({ error: { code: 'TOKEN_EXCHANGE_FAILED', message: tokenData.data || '换取 access_token 失败' } });
      return;
    }

    // 2.2 获取用户信息
    const userResp = await fetch(`${config.zhihu.baseUrl}/user`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const userData = await userResp.json() as {
      uid?: number;
      fullname?: string;
      avatar_path?: string;
      headline?: string;
      gender?: string;
      code?: number;
      data?: string;
    };

    if (!userData.uid) {
      log.warn('zhihu user fetch failed', userData);
      res.status(400).json({ error: { code: 'USER_FETCH_FAILED', message: userData.data || '获取用户信息失败' } });
      return;
    }

    const user: ZhihuUser = {
      uid: userData.uid,
      fullname: userData.fullname || '知乎用户',
      avatar_path: userData.avatar_path || '',
      headline: userData.headline,
      gender: userData.gender,
    };

    // 2.3 创建 session
    const sid = createSession(user);
    res.cookie('sid', sid, cookieOpts());

    // 2.4 跳回前端
    const clientUrl = req.query.state as string | undefined;
    res.redirect(clientUrl || (process.env.FRONTEND_URL || 'http://localhost:5173/'));
  } catch (err) {
    log.error('zhihu oauth callback error', err);
    res.status(500).json({ error: { code: 'OAUTH_ERROR', message: (err as Error).message } });
  }
});

// ────────────────────────────────────────────────────────────
// 3. 获取当前登录用户
// ────────────────────────────────────────────────────────────

authRouter.get('/me', (req, res) => {
  const sid = req.cookies?.sid as string | undefined;
  if (!sid) {
    res.json({ data: null });
    return;
  }
  const user = getSession(sid);
  res.json({ data: user });
});

// ────────────────────────────────────────────────────────────
// 4. 开发模式 Mock 登录（开发环境用，生产环境不走这里）
// ────────────────────────────────────────────────────────────

authRouter.post('/dev/login', (req, res) => {
  const mockUser: ZhihuUser = {
    uid: 999999,
    fullname: '开发用户',
    avatar_path: 'https://pic1.zhimg.com/v2-1234567890abcdef_avatar.jpg',
    headline: '本地开发中',
    gender: 'unknown',
  };
  const sid = createSession(mockUser);
  res.cookie('sid', sid, {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7,
    sameSite: 'lax',
    path: '/',
  });
  res.json({ data: mockUser });
});

// ────────────────────────────────────────────────────────────
// 5. 前端回调模式：前端提取 code 后发给此接口换 token
// ────────────────────────────────────────────────────────────

authRouter.post('/zhihu/exchange', async (req, res) => {
  const { code } = req.body as { code?: string };
  if (!code) {
    res.status(400).json({ error: { code: 'MISSING_CODE', message: '缺少 authorization_code' } });
    return;
  }

  try {
    const tokenResp = await fetch(`${config.zhihu.baseUrl}/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        app_id: config.zhihu.appId,
        app_key: config.zhihu.appKey,
        grant_type: 'authorization_code',
        redirect_uri: config.zhihu.redirectUri,
        code,
      }),
    });

    const tokenData = await tokenResp.json() as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
      code?: number;
      data?: string;
    };

    if (!tokenData.access_token) {
      log.warn('zhihu token exchange failed (frontend mode)', tokenData);
      res.status(400).json({ error: { code: 'TOKEN_EXCHANGE_FAILED', message: tokenData.data || '换取 access_token 失败' } });
      return;
    }

    const userResp = await fetch(`${config.zhihu.baseUrl}/user`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const userData = await userResp.json() as {
      uid?: number;
      fullname?: string;
      avatar_path?: string;
      headline?: string;
      gender?: string;
      code?: number;
      data?: string;
    };

    if (!userData.uid) {
      log.warn('zhihu user fetch failed (frontend mode)', userData);
      res.status(400).json({ error: { code: 'USER_FETCH_FAILED', message: userData.data || '获取用户信息失败' } });
      return;
    }

    const user: ZhihuUser = {
      uid: userData.uid,
      fullname: userData.fullname || '知乎用户',
      avatar_path: userData.avatar_path || '',
      headline: userData.headline,
      gender: userData.gender,
    };

    const sid = createSession(user);
    res.cookie('sid', sid, cookieOpts());

    res.json({ data: user });
  } catch (err) {
    log.error('zhihu oauth exchange error', err);
    res.status(500).json({ error: { code: 'OAUTH_ERROR', message: (err as Error).message } });
  }
});

// ────────────────────────────────────────────────────────────
// 5. 登出
// ────────────────────────────────────────────────────────────

authRouter.post('/logout', (req, res) => {
  const sid = req.cookies?.sid as string | undefined;
  if (sid) destroySession(sid);
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});
