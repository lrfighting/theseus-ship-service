/**
 * 轻量级内存 Session（开发环境够用）。
 * 生产环境应替换为 Redis / DB。
 */

export interface ZhihuUser {
  uid: number;
  fullname: string;
  avatar_path: string;
  headline?: string;
  gender?: string;
}

interface Session {
  user: ZhihuUser;
  createdAt: number;
}

const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 天

function newSid(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function createSession(user: ZhihuUser): string {
  const sid = newSid();
  sessions.set(sid, { user, createdAt: Date.now() });
  return sid;
}

export function getSession(sid: string): ZhihuUser | null {
  const s = sessions.get(sid);
  if (!s) return null;
  if (Date.now() - s.createdAt > SESSION_TTL_MS) {
    sessions.delete(sid);
    return null;
  }
  return s.user;
}

export function destroySession(sid: string): void {
  sessions.delete(sid);
}
