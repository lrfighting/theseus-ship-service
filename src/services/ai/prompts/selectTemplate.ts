import type { GenreTemplateKey } from '@shared/types/common';
import { TEMPLATES } from './templates';

/**
 * 根据原文 labels + tone 选择题材模板（PRD §5.5.5）。
 * 命中规则：labels 与 match_labels 有交集，第一个命中即用；否则用通用模板。
 */
export function selectGenreTemplate(labels: string[]): GenreTemplateKey {
  const lowered = labels.map((l) => l.toLowerCase());
  for (const [key, tpl] of Object.entries(TEMPLATES)) {
    if (key === 'prompt_template_general') continue;
    if (tpl.match_labels.some((m) => lowered.some((l) => l.includes(m.toLowerCase())))) {
      return key as GenreTemplateKey;
    }
  }
  return 'prompt_template_general';
}
