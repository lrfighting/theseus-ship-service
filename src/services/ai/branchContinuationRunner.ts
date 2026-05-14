/**
 * 分支续写 / 番外的具体执行逻辑：
 *  - 等背景就绪
 *  - 选模板 / 构造 prompt
 *  - 流式调用 provider
 *  - 增量推送 delta（仅推 generated_content 部分）
 *  - 解析最终 JSON 并装配 Branch
 */

import { getAiProvider } from './index';
import {
  buildBranchContinuationPrompt,
  buildExtraDirectionsPrompt,
  buildExtraPrompt,
  type BranchContinuationContext,
} from './prompts/builders';
import { selectGenreTemplate } from './prompts/selectTemplate';
import { aiUpstream } from '../../utils/errors';
import { config } from '../../config';
import type {
  BackgroundTaskInputBase,
  BranchContinuationInput,
  BranchContinuationResult,
  ExtraDirectionsResult,
  ExtraGenerationInput,
  ExtraResult,
} from '@shared/types/ai';
import type { Branch, KeyNode } from '@shared/types/story';
import { createLogger } from '../../utils/logger';

const log = createLogger('ai.branch');

export interface BranchStreamCallbacks {
  /** 把"已经积累到的 generated_content 增量"推回，便于 UI 实时打字 */
  onContentDelta: (delta: string) => void;
}

interface ExtractedContent {
  /** 从累计字符串中尝试提取 generated_content 的新增片段 */
  newDelta: string;
  /** 当前已知的 generated_content 全量 */
  totalContent: string;
}

/**
 * 极简的"流式 JSON 中 generated_content 字段渐进解析"。
 *
 * 我们假设 AI 会按 schema 输出，generated_content 是 JSON 中的字符串字段，
 * 形如：`{"generated_content":"......","summary":"..."}`。
 *
 * 在流到完整字符串结尾之前，我们就把 ".....".inner 中的新增部分一段段
 * 推给前端展示。简单匹配 `"generated_content":"<inner>"`，inner 中的转义符
 * 在这种字符串里几乎不出现，足够 P0 体验。
 */
export function stripMarkdownCodeBlocks(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    const firstNewline = trimmed.indexOf('\n');
    const lastFence = trimmed.lastIndexOf('```');
    if (firstNewline !== -1 && lastFence > firstNewline) {
      return trimmed.slice(firstNewline + 1, lastFence).trim();
    }
  }
  return trimmed;
}

/** 从模型输出中提取首个完整 JSON 对象子串（与 orchestrator.parseJson 策略一致） */
function extractJsonObjectSubstring(raw: string): string {
  const withoutFence = stripMarkdownCodeBlocks(raw).trim();
  const startObj = withoutFence.indexOf('{');
  const endObj = withoutFence.lastIndexOf('}');
  if (startObj !== -1 && endObj > startObj) {
    return withoutFence.slice(startObj, endObj + 1);
  }
  return withoutFence;
}

type ParsedBranchPayload = {
  generated_content: string;
  summary?: string;
  next_key_node: KeyNode | null;
  impact: BranchContinuationResult['impact'];
  is_terminal: boolean;
};

function buildProseFallbackPayload(
  accumulated: string,
  input: BranchContinuationInput,
  maxDepth: number,
): ParsedBranchPayload {
  const raw = stripMarkdownCodeBlocks(accumulated).trim();
  const gen = raw.replace(/^(好的|以下是|下面是)[，。:\s「」]*/u, '').trim() || '（模型未返回可解析 JSON，此为原始输出占位。）';
  const firstLine = gen.split(/\n/).find((l) => l.trim())?.trim() ?? gen;
  const summary = firstLine.slice(0, 120);
  const atLast = input.depth >= maxDepth;
  const next: KeyNode | null = atLast
    ? null
    : {
        node_id: `fallback_node_${input.branch_id}`,
        title: '后续抉择',
        summary: '模型未按 JSON 返回节点结构，已生成通用续写锚点，可继续分支或自定义。',
        importance: 'side',
        node_type: 'plot_hook',
        source: 'ai_continuation',
        depth: input.depth,
        parent_branch_id: input.branch_id,
        ai_paragraph_id: `ap_${input.branch_id}`,
        anchor_text: firstLine.slice(0, 36),
        branch_options: [
          {
            option_id: `fb_${input.branch_id}_1`,
            text: '沿当前局势加压推进，承担更高风险换取翻盘机会',
            tone: '冲突升级',
          },
          {
            option_id: `fb_${input.branch_id}_2`,
            text: '先稳住自身与同伴，收缩风险再寻找转机',
            tone: '稳健',
          },
          {
            option_id: `fb_${input.branch_id}_3`,
            text: '利用信息差或非常规手段试探并改写走向',
            tone: '意外反转',
          },
        ],
      };

  return {
    generated_content: gen,
    summary,
    next_key_node: next,
    impact: {
      branch_id: input.branch_id,
      character_changes: [],
      relation_changes: [],
      new_events: [],
      object_changes: [],
    },
    is_terminal: atLast,
  };
}

function parseBranchContinuationPayload(
  accumulated: string,
  input: BranchContinuationInput,
): ParsedBranchPayload {
  const maxDepth = input.constraints?.max_depth ?? 5;
  const tries = [stripMarkdownCodeBlocks(accumulated).trim(), extractJsonObjectSubstring(accumulated)];
  for (const cand of [...new Set(tries)]) {
    if (!cand) continue;
    try {
      const parsed = JSON.parse(cand) as ParsedBranchPayload;
      if (typeof parsed.generated_content === 'string' && parsed.generated_content.trim()) {
        if (!parsed.impact) {
          parsed.impact = {
            branch_id: input.branch_id,
            character_changes: [],
            relation_changes: [],
            new_events: [],
            object_changes: [],
          };
        } else if (!parsed.impact.branch_id) {
          parsed.impact = { ...parsed.impact, branch_id: input.branch_id };
        }
        return parsed;
      }
    } catch {
      /* try next */
    }
  }

  log.warn('branch continuation: non-JSON or empty generated_content, using prose fallback', {
    sample: accumulated.slice(0, 160),
  });
  return buildProseFallbackPayload(accumulated, input, maxDepth);
}

export function makeContentExtractor() {
  let lastTotal = '';
  return (accumulated: string): ExtractedContent => {
    const m = /"generated_content"\s*:\s*"((?:\\.|[^"\\])*)/.exec(accumulated);
    if (!m) return { newDelta: '', totalContent: lastTotal };
    // 解析转义
    let value = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    if (value.length <= lastTotal.length) return { newDelta: '', totalContent: lastTotal };
    const delta = value.slice(lastTotal.length);
    lastTotal = value;
    return { newDelta: delta, totalContent: value };
  };
}

// ───────────────────────────────────────────────────────
// 分支续写
// ───────────────────────────────────────────────────────

export async function runBranchContinuation(
  input: BranchContinuationInput,
  ctx: BranchContinuationContext & {
    story: BackgroundTaskInputBase['story'];
  },
  callbacks: BranchStreamCallbacks,
): Promise<BranchContinuationResult> {
  const templateKey = selectGenreTemplate(ctx.story.labels);
  const messages = buildBranchContinuationPrompt(input, ctx, templateKey);
  const provider = getAiProvider();

  let accumulated = '';
  const extract = makeContentExtractor();

  for await (const chunk of provider.stream(messages, { json: true })) {
    if (chunk.done) break;
    accumulated += chunk.text;
    const { newDelta } = extract(accumulated);
    if (newDelta) callbacks.onContentDelta(newDelta);
  }

  const parsed = parseBranchContinuationPayload(accumulated, input);

  const branch: Branch = {
    branch_id: input.branch_id,
    branch_type: input.branch_type,
    source_node_id: input.source_node_id,
    parent_branch_id: input.parent_branch_id,
    depth: input.depth,
    choice_type: input.choice_type,
    choice_text: input.choice_text,
    status: 'success',
    generated_content: parsed.generated_content,
    summary: parsed.summary,
    next_node_id: parsed.next_key_node?.node_id ?? null,
    is_terminal: parsed.is_terminal,
    created_at: Date.now(),
    updated_at: Date.now(),
    model: provider.defaultModel,
    prompt_version: config.prompt.version,
  };

  // 保证 impact 的 branch_id 与 branch 一致
  const impact = parsed.impact ?? {
    character_changes: [],
    relation_changes: [],
    new_events: [],
    object_changes: [],
  };

  return {
    branch,
    next_key_node: parsed.next_key_node ?? null,
    impact: { ...impact, branch_id: branch.branch_id },
    meta: {
      model: provider.defaultModel,
      prompt_version: config.prompt.version,
      template_key: templateKey,
      is_terminal: parsed.is_terminal,
    },
  };
}

// ───────────────────────────────────────────────────────
// 番外方向
// ───────────────────────────────────────────────────────

export async function runExtraDirections(
  characters: BranchContinuationContext['characters'],
  summary: BranchContinuationContext['summary'],
  labels: string[],
): Promise<ExtraDirectionsResult> {
  const templateKey = selectGenreTemplate(labels);
  const messages = buildExtraDirectionsPrompt(characters ?? [], summary, templateKey);
  const provider = getAiProvider();
  const resp = await provider.complete(messages, { json: true });
  try {
    return JSON.parse(stripMarkdownCodeBlocks(resp.text)) as ExtraDirectionsResult;
  } catch (err) {
    throw aiUpstream(`AI returned invalid JSON for extra directions: ${(err as Error).message}`);
  }
}

// ───────────────────────────────────────────────────────
// 番外正文（流式）
// ───────────────────────────────────────────────────────

export async function runExtra(
  input: ExtraGenerationInput,
  ctx: BranchContinuationContext & { story: BackgroundTaskInputBase['story'] },
  callbacks: BranchStreamCallbacks,
): Promise<ExtraResult> {
  const templateKey = selectGenreTemplate(ctx.story.labels);
  const messages = buildExtraPrompt(input, ctx, templateKey);
  const provider = getAiProvider();

  let accumulated = '';
  const extract = makeContentExtractor();

  for await (const chunk of provider.stream(messages, { json: true })) {
    if (chunk.done) break;
    accumulated += chunk.text;
    const { newDelta } = extract(accumulated);
    if (newDelta) callbacks.onContentDelta(newDelta);
  }

  let parsed: { extra_title: string; extra_summary?: string; generated_content: string };
  try {
    parsed = JSON.parse(stripMarkdownCodeBlocks(accumulated));
  } catch (err) {
    throw aiUpstream(`AI returned invalid JSON for extra: ${(err as Error).message}`);
  }

  const branch: Branch = {
    branch_id: input.branch_id,
    branch_type: 'extra',
    parent_branch_id: null,
    depth: 1,
    choice_type: input.choice_type,
    choice_text: input.picked_direction?.title ?? input.custom_title ?? '番外',
    extra_title: parsed.extra_title,
    extra_summary: parsed.extra_summary,
    status: 'success',
    generated_content: parsed.generated_content,
    next_node_id: null,
    is_terminal: true,
    created_at: Date.now(),
    updated_at: Date.now(),
    model: provider.defaultModel,
    prompt_version: config.prompt.version,
  };

  return {
    branch,
    meta: {
      model: provider.defaultModel,
      prompt_version: config.prompt.version,
      template_key: templateKey,
    },
  };
}
