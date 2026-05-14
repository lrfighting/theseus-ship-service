import { createHash } from 'node:crypto';

/**
 * 计算稳定的内容哈希，作为 AI 缓存键的核心维度。
 * 同时对前缀进行轻量归一化，避免空白差异导致缓存击穿。
 */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function contentHash(content: string): string {
  const normalized = content
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return sha256(normalized);
}

export function shortHash(input: string, len = 12): string {
  return sha256(input).slice(0, len);
}
