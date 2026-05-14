import { config } from '../../config';
import type { StoryAIProvider } from './provider';
import { kimiProvider } from './kimi';
import { mockProvider } from './mock';
import { createLogger } from '../../utils/logger';

const log = createLogger('ai');

let cachedProvider: StoryAIProvider | null = null;

export function getAiProvider(): StoryAIProvider {
  if (cachedProvider) return cachedProvider;

  switch (config.ai.provider) {
    case 'kimi':
      if (!config.ai.kimi.apiKey) {
        log.warn('AI_PROVIDER=kimi but KIMI_API_KEY missing; falling back to mock.');
        cachedProvider = mockProvider;
      } else {
        cachedProvider = kimiProvider;
      }
      break;
    case 'mock':
    default:
      cachedProvider = mockProvider;
  }

  log.info(`Active AI provider: ${cachedProvider.name} (model=${cachedProvider.defaultModel})`);
  return cachedProvider;
}

export type { StoryAIProvider } from './provider';
