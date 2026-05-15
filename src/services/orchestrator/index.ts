/**
 * 任务编排器（PRD §5.4）。
 *
 * 主要职责：
 *  - 背景任务"按 cache_key 去重 + 缓存命中即跳过"
 *  - 分支续写在开始前等待背景任务全部就绪
 *  - 同一 work_id 的分支续写串行执行，避免会话内并发污染
 *
 * 注意：服务端对单台进程内的协调；多机部署时需借助外部消息总线（P1+）。
 */

import { createLogger } from '../../utils/logger';
import { readCache, writeCache } from '../cache';
import { buildCacheKey } from '../cache/keys';
import type { CacheKeyParts } from '../cache';
import { config } from '../../config';
import { getAiProvider } from '../ai';
import {
  buildCharactersPrompt,
  buildKeyNodesPrompt,
  buildObjectsPrompt,
  buildRelationsPrompt,
  buildSummaryPrompt,
  buildWorldPrompt,
} from '../ai/prompts/builders';
import { selectGenreTemplate } from '../ai/prompts/selectTemplate';
import { aiUpstream } from '../../utils/errors';
import type {
  BackgroundTaskInputBase,
  BackgroundTaskType,
  CharacterProfile,
  ObjectProfile,
  RelationGraph,
  StorySummaryData,
  WorldContext,
} from '@shared/types/ai';
import type { BranchOption, KeyNode, KeyNodeBundle } from '@shared/types/story';

const log = createLogger('orchestrator');

interface BackgroundResult<T> {
  data: T;
  source: 'live' | 'memory' | 'file' | 'cdn';
  meta: {
    cache_key: string;
    template_key: string;
    prompt_version: string;
    model: string;
    generated_at: number;
  };
}

const inflight = new Map<string, Promise<BackgroundResult<unknown>>>();
const branchSerial = new Map<string, Promise<unknown>>();

function getProviderModel(): string {
  return getAiProvider().defaultModel;
}

function buildParts(input: BackgroundTaskInputBase, taskType: BackgroundTaskType): CacheKeyParts {
  return {
    work_id: input.work_id,
    content_hash: input.content_hash,
    task_type: taskType,
    prompt_version: config.prompt.version,
    model: getProviderModel(),
  };
}

async function tryReadCache<T>(parts: CacheKeyParts) {
  const hit = await readCache<T>(parts);
  if (!hit) return null;
  return {
    data: hit.entry.data,
    source: hit.source,
    meta: {
      cache_key: hit.entry.cache_key,
      template_key: 'cached',
      prompt_version: hit.entry.prompt_version,
      model: hit.entry.model,
      generated_at: hit.entry.generated_at,
    },
  } as BackgroundResult<T>;
}

function parseJson<T>(text: string): T {
  const cleaned = text.trim();
  const withoutFence = (() => {
    if (!cleaned.startsWith('```')) return cleaned;
    const firstNewline = cleaned.indexOf('\n');
    const lastFence = cleaned.lastIndexOf('```');
    if (firstNewline !== -1 && lastFence > firstNewline) {
      return cleaned.slice(firstNewline + 1, lastFence).trim();
    }
    return cleaned;
  })();
  const candidate = (() => {
    const startObj = withoutFence.indexOf('{');
    const endObj = withoutFence.lastIndexOf('}');
    if (startObj !== -1 && endObj > startObj) {
      return withoutFence.slice(startObj, endObj + 1);
    }
    const startArr = withoutFence.indexOf('[');
    const endArr = withoutFence.lastIndexOf(']');
    if (startArr !== -1 && endArr > startArr) {
      return withoutFence.slice(startArr, endArr + 1);
    }
    return withoutFence;
  })();
  try {
    return JSON.parse(candidate) as T;
  } catch (err) {
    throw aiUpstream(`AI returned non-JSON output: ${(err as Error).message}`, {
      text: candidate.slice(0, 1200),
    });
  }
}

const KEY_NODE_MIN_CHAR_GAP = 220;
const KEY_NODE_RELAXED_CHAR_GAP = 120;
const KEY_NODE_MIN_PARAGRAPH_GAP = 2;

function getNodeTargetRange(totalChars: number): { min: number; max: number } {
  if (totalChars < 3000) return { min: 2, max: 4 };
  if (totalChars <= 8000) return { min: 5, max: 8 };
  return { min: 6, max: 15 };
}

function normalizeOptionText(text: string): string {
  return text
    .replace(/^\s*[0-9一二三四五六七八九十]+[.、:：)\]）]\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isGenericOption(text: string): boolean {
  return /(先看看|再看看|随机应变|走一步看一步|继续观察|静观其变|先等等|随便|这一刻|此时|当下局面|这种时候)/.test(
    text,
  );
}

/** 选项里常见的「脱锚」题材：段落里没出现则整句剔除 */
function isMetaOrOutOfStoryOption(text: string, paragraph: string): boolean {
  const meta =
    /(舆论|全网|热搜|公关|实锤|水军|爆料|反转局|玄学|风水|锁魂|律师函|微博|抖音|小红书|开盒|人肉|起诉)/;
  if (!meta.test(text)) return false;
  return !meta.test(paragraph);
}

/**
 * 选项语义关联检查（宽松）：选项不应与段落完全无关。
 * 不再强制要求连续字符匹配，改为拒绝明显的垃圾模板选项。
 */
function optionSemanticallyRelated(text: string, paragraph: string): boolean {
  const t = text.replace(/\s/g, '');
  // 拒绝包含"仍处在/语境/仍基于"等兜底模板词
  if (/(仍处在|语境[:：]|仍基于)/.test(t)) return false;
  return true;
}

function buildParagraphGroundedFallbackOptions(paragraph: string, node: KeyNode): BranchOption[] {
  const id = node.node_id;
  return [
    {
      option_id: `${id}_fb_1`,
      text: `主动改写——不再等待，以最直接的方式打破现状，哪怕代价是无法回头`,
      tone: '冲突升级',
    },
    {
      option_id: `${id}_fb_2`,
      text: `承受命运——咽下这一刻，沉默地接受，看命运会把自己带向何处`,
      tone: '稳健',
    },
    {
      option_id: `${id}_fb_3`,
      text: `走第三条路——拒绝非此即彼，在别人都没想到的方向找到出口`,
      tone: '意外反转',
    },
  ];
}

function sanitizeBranchOptions(
  raw: BranchOption[] | undefined,
  node: KeyNode,
  paragraph: string,
): BranchOption[] {
  const uniq = new Set<string>();
  const cleaned: BranchOption[] = [];
  for (const opt of raw ?? []) {
    const text = normalizeOptionText(opt?.text ?? '');
    if (!text || text.length < 8) continue;
    if (isGenericOption(text)) continue;
    if (isMetaOrOutOfStoryOption(text, paragraph)) continue;
    if (!optionSemanticallyRelated(text, paragraph)) continue;
    if (uniq.has(text)) continue;
    uniq.add(text);
    cleaned.push({
      option_id: opt?.option_id?.trim() || `${node.node_id}_opt_${cleaned.length + 1}`,
      text,
      tone: opt?.tone?.trim() || '剧情推进',
    });
    if (cleaned.length >= 3) break;
  }

  if (cleaned.length < 2) {
    for (const opt of buildParagraphGroundedFallbackOptions(paragraph, node)) {
      if (uniq.has(opt.text)) continue;
      uniq.add(opt.text);
      cleaned.push(opt);
      if (cleaned.length >= 3) break;
    }
  }

  return cleaned.slice(0, 3);
}

/**
 * 段落是否具备「读者可岔路选择」的叙事基础（过滤纯场面推进、纯到场描写等）。
 */
function isAcceptableKeyNodeParagraph(text: string): boolean {
  const t = text.trim();
  if (!t) return false;

  const explicitDilemma =
    /(犹豫|抉择|决定|选择|要不要|该不该|能不能|会不会|要么|突然|没想到|就在这时|倘若|如果|万一|质问|对峙|威胁|揭露|真相|秘密|怀疑|冲不冲|动不动|说不说|走不走|救不救|信不信|揭不揭)/;
  if (explicitDilemma.test(t) || /[？?]/.test(t)) return true;

  const tension = /(火势|大火|失控|浓烟|窒息|坍塌|刀|枪|追杀|围困|绝望|生死|暴露|识破|中计)/;
  const mustChoose = /(只能|不得不|必须|再不|立刻|再也|要么|还是|或者|是否)/;
  if (tension.test(t) && mustChoose.test(t)) return true;

  /** 隐性两难：同一语境下出现相互拉扯的目标（如「陌生人 vs 火车」） */
  if (/(而|但).{0,35}(即将|就要|来不及|赶不上了)/.test(t)) return true;
  if (/(一边|一方面).{0,40}(另一边|另一方面)/.test(t)) return true;

  // 纯「他人赶到现场」类客观叙述：无岔路
  if (
    /(赶到|抵达|来到|冲入)(了)?(现场|楼下|屋外|门口)/.test(t) &&
    !explicitDilemma.test(t) &&
    !/[？?]/.test(t)
  ) {
    const onlyArrival =
      /(第一时间|立刻|急忙).{0,12}(赶到|抵达|来到)/.test(t) &&
      !/(喊|拦|冲|找|问|听|看|发现|争执|决定|选择)/.test(t);
    if (onlyArrival) return false;
  }

  return false;
}

/** 宽松：用于「宁可要节点也不要空白」时的最低门槛（仍排除极短段） */
function isAcceptableKeyNodeParagraphRelaxed(text: string): boolean {
  const t = text.trim();
  if (t.length < 20) return false;
  if (isAcceptableKeyNodeParagraph(t)) return true;

  // 排除纯信息交代 / 日常琐事 / 背景铺陈
  const pureInfoPattern = /^(那年|小时候|从前|据说|相传|自古|一直以来|众所周知|阿娘|娘亲|母亲|父亲|爹爹)[:,，。]/;
  if (pureInfoPattern.test(t)) return false;
  if (/(做得一手好|擅长|从小|自幼|家传|祖传|据说|相传|传说|很久以前)/.test(t) && !/(犹豫|抉择|决定|选择|要不要|突然|没想到|如果|对峙|威胁|揭露|真相)/.test(t)) {
    return false;
  }

  // 这些信号单独不足以成为节点，需要组合判断
  let weakSignals = 0;
  if (/[？?！!]/.test(t)) weakSignals++;
  if (/(心想|暗想|心里|不禁|不由得|忽然|猛地)/.test(t)) weakSignals++;
  if (/(说道|问道|喊道|低声|回答|叹气|冷笑|怒道)/.test(t)) weakSignals++;
  if (/(只能|不得不|必须|再不|立刻|再也|要么|还是|或者|是否)/.test(t)) weakSignals++;

  // 需要至少2个弱信号才通过宽松门槛
  return weakSignals >= 2;
}

function paragraphWeakArrivalOnly(text: string): boolean {
  const explicitDilemma =
    /(犹豫|抉择|决定|选择|要不要|该不该|能不能|会不会|要么|突然|没想到|倘若|如果|万一|质问|对峙|威胁|揭露|真相|秘密|怀疑)/;
  if (explicitDilemma.test(text) || /[？?]/.test(text)) return false;
  return (
    /(第一时间|立刻|急忙).{0,12}(赶到|抵达|来到)/.test(text) &&
    !/(喊|拦|冲|找|问|听|看|发现|争执|决定|选择)/.test(text)
  );
}

function scoreKeyNode(
  node: KeyNode,
  paragraphText: string,
  paragraphStarts: number[],
  totalChars: number,
  paragraphCount: number,
): number {
  const pi = node.paragraph_index ?? -1;
  if (pi < 0 || pi >= paragraphCount) return -999;
  if (!isAcceptableKeyNodeParagraphRelaxed(paragraphText)) return -999;

  const pos = totalChars > 0 ? paragraphStarts[pi] / totalChars : 0;
  if (pos < 0.1 || pos > 0.95) return -999;

  let score = 0;
  score += (node.confidence ?? 0.6) * 4;
  score += node.importance === 'main' ? 1.2 : 0.4;
  score += Math.min(node.branch_options.length, 3) * 0.8;
  if (node.anchor_text && node.anchor_text.trim().length >= 8) score += 0.6;
  if (node.summary && node.summary.trim().length >= 12) score += 0.4;
  if (/^\d+$/.test(node.title.trim())) score -= 2.5;

  if (isAcceptableKeyNodeParagraph(paragraphText)) score += 3.2;
  else score -= 1.5; // 弱段落大幅扣分，优先选择真正的转折点

  if (paragraphWeakArrivalOnly(paragraphText)) score -= 4.5;

  if (
    /(犹豫|抉择|决定|选择|要不要|该不该|能不能|会不会|要么|如果|万一|质问|对峙|威胁|揭露|真相|怀疑)/.test(
      paragraphText,
    )
  ) {
    score += 1.6;
  }
  if (/[？?]/.test(paragraphText)) score += 1.2;
  if (/(只能|不得不|必须|再不|立刻|再也)/.test(paragraphText)) score += 0.8;

  return score;
}

/**
 * 模型未产出或全部被过滤时：按篇幅在正文段落中均匀抽样，保证有可点节点（选项为段落锚定兜底）。
 */
function synthesizeFallbackKeyNodes(
  input: BackgroundTaskInputBase,
  paragraphs: string[],
  want: number,
): KeyNode[] {
  if (paragraphs.length === 0 || want <= 0) return [];
  const n = Math.min(want, paragraphs.length);
  const indices: number[] = [];
  if (n === 1) {
    indices.push(Math.min(paragraphs.length - 1, Math.max(0, Math.floor(paragraphs.length / 2))));
  } else {
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(((i + 1) / (n + 1)) * paragraphs.length);
      indices.push(Math.min(paragraphs.length - 1, Math.max(0, idx)));
    }
  }
  const uniq = [...new Set(indices)].sort((a, b) => a - b);
  const out: KeyNode[] = [];
  for (const pi of uniq) {
    const ptext = paragraphs[pi];
    if (ptext.length < 10) continue;
    const anchor = ptext.slice(0, 36);
    const nodeId = `syn_${input.work_id}_${pi}_${input.content_hash.slice(0, 8)}`;
    const stub: KeyNode = {
      node_id: nodeId,
      title: anchor.slice(0, 10).replace(/\s/g, '') || `节点${pi + 1}`,
      summary: `这一段可走向不同发展，请结合下文做选择。`,
      importance: 'side',
      node_type: 'plot_hook',
      source: 'original',
      depth: 0,
      parent_branch_id: null,
      paragraph_index: pi,
      anchor_text: anchor,
      quote_hash: '',
      confidence: 0.42,
      branch_options: [],
    };
    stub.branch_options = buildParagraphGroundedFallbackOptions(ptext, stub);
    out.push(stub);
  }
  return out;
}

function normalizeAndSelectKeyNodes(
  input: BackgroundTaskInputBase,
  rawNodes: KeyNode[],
): KeyNode[] {
  const paragraphs = input.story.content
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length === 0) return [];

  const paragraphStarts: number[] = [];
  let cursor = 0;
  for (const p of paragraphs) {
    paragraphStarts.push(cursor);
    cursor += p.length + 1;
  }
  const totalChars = Math.max(cursor, input.story.content.length);
  const { min, max } = getNodeTargetRange(totalChars);
  const minAdjusted = Math.min(min, Math.max(1, Math.min(paragraphs.length, Math.ceil(paragraphs.length / 4) + 1)));

  if (rawNodes.length === 0) {
    return synthesizeFallbackKeyNodes(input, paragraphs, Math.min(minAdjusted, max));
  }

  const normalizedCandidates = rawNodes
    .map((node, idx): KeyNode | null => {
      const pi = Number(node.paragraph_index ?? -1);
      if (!Number.isInteger(pi) || pi < 0 || pi >= paragraphs.length) return null;

      const ptext = paragraphs[pi];
      if (!isAcceptableKeyNodeParagraphRelaxed(ptext)) return null;

      const title = (node.title ?? '').toString().trim();
      const summary = (node.summary ?? '').toString().trim();
      if (!title || !summary) return null;
      if (/^\d+$/.test(title)) return null;

      const normalized: KeyNode = {
        ...node,
        node_id: node.node_id?.trim() || `node_${pi}_${idx + 1}`,
        title: title.slice(0, 24),
        summary: summary.slice(0, 80),
        source: 'original',
        depth: 0,
        parent_branch_id: null,
        paragraph_index: pi,
        anchor_text: (node.anchor_text ?? '').trim() || paragraphs[pi].slice(0, 36),
        confidence: typeof node.confidence === 'number' ? node.confidence : 0.65,
      };
      normalized.branch_options = sanitizeBranchOptions(node.branch_options, normalized, ptext);
      if (normalized.branch_options.length < 2) return null;
      return normalized;
    })
    .filter((n): n is KeyNode => Boolean(n));

  if (normalizedCandidates.length === 0) {
    return synthesizeFallbackKeyNodes(input, paragraphs, Math.min(minAdjusted, max));
  }

  const deduped: KeyNode[] = [];
  const seenParagraph = new Set<number>();
  const seenAnchor = new Set<string>();
  for (const node of normalizedCandidates) {
    const p = node.paragraph_index ?? -1;
    const anchor = (node.anchor_text ?? '').trim();
    if (seenParagraph.has(p)) continue;
    if (anchor && seenAnchor.has(anchor)) continue;
    seenParagraph.add(p);
    if (anchor) seenAnchor.add(anchor);
    deduped.push(node);
  }

  const ranked = deduped
    .map((node) => {
      const pi = node.paragraph_index ?? 0;
      const ptext = paragraphs[pi] ?? '';
      return {
        node,
        score: scoreKeyNode(node, ptext, paragraphStarts, totalChars, paragraphs.length),
      };
    })
    .filter((x) => x.score > -900)
    .sort((a, b) => b.score - a.score);

  const picked: Array<{ node: KeyNode; score: number }> = [];
  const canPlace = (candidate: KeyNode, charGap: number, paragraphGap: number) => {
    const cp = candidate.paragraph_index ?? 0;
    const cStart = paragraphStarts[cp] ?? 0;
    return picked.every((pickedNode) => {
      const pp = pickedNode.node.paragraph_index ?? 0;
      const pStart = paragraphStarts[pp] ?? 0;
      return (
        Math.abs(cp - pp) >= paragraphGap &&
        Math.abs(cStart - pStart) >= charGap
      );
    });
  };

  for (const item of ranked) {
    if (picked.length >= max) break;
    if (canPlace(item.node, KEY_NODE_MIN_CHAR_GAP, KEY_NODE_MIN_PARAGRAPH_GAP)) {
      picked.push(item);
    }
  }

  if (picked.length < minAdjusted) {
    for (const item of ranked) {
      if (picked.length >= minAdjusted) break;
      if (picked.some((x) => x.node.node_id === item.node.node_id)) continue;
      if (canPlace(item.node, KEY_NODE_RELAXED_CHAR_GAP, 1)) {
        picked.push(item);
      }
    }
  }

  if (picked.length === 0 && ranked.length > 0) {
    picked.push(...ranked.slice(0, Math.min(max, 3)));
  }

  let result = picked
    .sort((a, b) => (a.node.paragraph_index ?? 0) - (b.node.paragraph_index ?? 0))
    .slice(0, max)
    .map((x) => x.node);

  if (result.length === 0) {
    result = synthesizeFallbackKeyNodes(input, paragraphs, Math.min(minAdjusted, max));
  }

  return result;
}

// ────────────────────────────────────────────────────────────
// 背景任务：每个 builder 包一层缓存 + inflight 去重
// ────────────────────────────────────────────────────────────

export async function getOrCreateSummary(
  input: BackgroundTaskInputBase,
): Promise<BackgroundResult<StorySummaryData>> {
  return runCached('summary', input, async () => {
    const provider = getAiProvider();
    const tpl = input.template_key ?? selectGenreTemplate(input.story.labels);
    const messages = buildSummaryPrompt(input, tpl);
    const resp = await provider.complete(messages, { json: true });
    const parsed = parseJson<Omit<StorySummaryData, 'work_id' | 'content_hash'>>(resp.text);
    const data: StorySummaryData = {
      work_id: input.work_id,
      content_hash: input.content_hash,
      ...parsed,
    };
    return { data, model: resp.model, tpl };
  });
}

export async function getOrCreateWorld(
  input: BackgroundTaskInputBase,
): Promise<BackgroundResult<WorldContext>> {
  return runCached('world', input, async () => {
    const provider = getAiProvider();
    const tpl = input.template_key ?? selectGenreTemplate(input.story.labels);
    const messages = buildWorldPrompt(input, tpl);
    const resp = await provider.complete(messages, { json: true });
    const parsed = parseJson<Omit<WorldContext, 'work_id'>>(resp.text);
    const data: WorldContext = { work_id: input.work_id, ...parsed };
    return { data, model: resp.model, tpl };
  });
}

export async function getOrCreateCharacters(
  input: BackgroundTaskInputBase,
): Promise<BackgroundResult<CharacterProfile[]>> {
  return runCached('characters', input, async () => {
    const provider = getAiProvider();
    const tpl = input.template_key ?? selectGenreTemplate(input.story.labels);
    const messages = buildCharactersPrompt(input, tpl);
    const resp = await provider.complete(messages, { json: true });
    const parsed = parseJson<{ characters: CharacterProfile[] }>(resp.text);
    return { data: parsed.characters ?? [], model: resp.model, tpl };
  });
}

export async function getOrCreateRelations(
  input: BackgroundTaskInputBase,
): Promise<BackgroundResult<RelationGraph>> {
  return runCached('relations', input, async () => {
    const provider = getAiProvider();
    const tpl = input.template_key ?? selectGenreTemplate(input.story.labels);
    const characters = await getOrCreateCharacters(input);
    const messages = buildRelationsPrompt(input, characters.data, tpl);
    const resp = await provider.complete(messages, { json: true });
    const parsed = parseJson<Omit<RelationGraph, 'work_id'>>(resp.text);
    const data: RelationGraph = { work_id: input.work_id, ...parsed };
    return { data, model: resp.model, tpl };
  });
}

export async function getOrCreateObjects(
  input: BackgroundTaskInputBase,
): Promise<BackgroundResult<ObjectProfile[]>> {
  return runCached('objects', input, async () => {
    const provider = getAiProvider();
    const tpl = input.template_key ?? selectGenreTemplate(input.story.labels);
    const messages = buildObjectsPrompt(input, tpl);
    const resp = await provider.complete(messages, { json: true });
    const parsed = parseJson<{ objects: ObjectProfile[] }>(resp.text);
    return { data: parsed.objects ?? [], model: resp.model, tpl };
  });
}

export async function getOrCreateKeyNodes(
  input: BackgroundTaskInputBase,
): Promise<BackgroundResult<KeyNodeBundle>> {
  return runCached('key_nodes', input, async () => {
    const provider = getAiProvider();
    const tpl = input.template_key ?? selectGenreTemplate(input.story.labels);
    const messages = buildKeyNodesPrompt(input, tpl);
    const resp = await provider.complete(messages, { json: true });
    const parsed = parseJson<KeyNodeBundle>(resp.text);
    const selected = normalizeAndSelectKeyNodes(input, parsed.key_nodes ?? []);
    const data: KeyNodeBundle = {
      work_id: input.work_id,
      content_hash: input.content_hash,
      key_nodes: selected,
    };
    return { data, model: resp.model, tpl };
  });
}

// ────────────────────────────────────────────────────────────
// 内部：缓存 + inflight 去重
// ────────────────────────────────────────────────────────────

interface LiveResult<T> {
  data: T;
  model: string;
  tpl: string;
}

function runCached<T>(
  taskType: BackgroundTaskType,
  input: BackgroundTaskInputBase,
  runner: () => Promise<LiveResult<T>>,
): Promise<BackgroundResult<T>> {
  const parts = buildParts(input, taskType);
  const inflightKey = buildCacheKey(parts);

  if (!input.force_refresh) {
    const existing = inflight.get(inflightKey) as Promise<BackgroundResult<T>> | undefined;
    if (existing) return existing;
  }

  const job = (async (): Promise<BackgroundResult<T>> => {
    if (!input.force_refresh) {
      const hit = await tryReadCache<T>(parts);
      if (hit) return hit;
    }

    const live = await runner();
    const partsWithModel: CacheKeyParts = { ...parts, model: live.model };
    const entry = await writeCache(partsWithModel, live.data);
    return {
      data: live.data,
      source: 'live',
      meta: {
        cache_key: entry.cache_key,
        template_key: live.tpl,
        prompt_version: parts.prompt_version,
        model: live.model,
        generated_at: entry.generated_at,
      },
    };
  })();

  inflight.set(inflightKey, job as Promise<BackgroundResult<unknown>>);
  job.finally(() => inflight.delete(inflightKey)).catch(() => undefined);
  return job;
}

// ────────────────────────────────────────────────────────────
// 全套背景信息：分支续写前的依赖检查
// ────────────────────────────────────────────────────────────

export interface FullBackgroundResult {
  summary: StorySummaryData;
  world: WorldContext;
  characters: CharacterProfile[];
  relations: RelationGraph;
  objects: ObjectProfile[];
  template_key: string;
}

export interface BackgroundProgress {
  total: number;
  ready: number;
  failed: number;
}

/**
 * 等待背景任务全部就绪。
 * onProgress：每完成一个子任务回调一次（用于 SSE 推送 queued 进度）。
 */
export async function waitForBackground(
  input: BackgroundTaskInputBase,
  onProgress?: (p: BackgroundProgress) => void,
): Promise<FullBackgroundResult> {
  const progress: BackgroundProgress = { total: 5, ready: 0, failed: 0 };

  const track = <T>(p: Promise<BackgroundResult<T>>) =>
    p.then(
      (v) => {
        progress.ready += 1;
        onProgress?.({ ...progress });
        return v;
      },
      (err) => {
        progress.failed += 1;
        onProgress?.({ ...progress });
        throw err;
      },
    );

  const summaryP = track(getOrCreateSummary(input));
  const worldP = track(getOrCreateWorld(input));
  const charactersP = track(getOrCreateCharacters(input));
  const objectsP = track(getOrCreateObjects(input));
  // relations depends on characters; tracked under same total
  const relationsP = track(getOrCreateRelations(input));

  const [summary, world, characters, objects, relations] = await Promise.all([
    summaryP,
    worldP,
    charactersP,
    objectsP,
    relationsP,
  ]);

  return {
    summary: summary.data,
    world: world.data,
    characters: characters.data,
    relations: relations.data,
    objects: objects.data,
    template_key: world.meta.template_key,
  };
}

// ────────────────────────────────────────────────────────────
// 同一 work_id 的分支任务串行
// ────────────────────────────────────────────────────────────

export async function withBranchSerial<T>(workId: string, fn: () => Promise<T>): Promise<T> {
  const prev = branchSerial.get(workId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  branchSerial.set(
    workId,
    next
      .catch(() => undefined)
      .finally(() => {
        if (branchSerial.get(workId) === next) branchSerial.delete(workId);
      }),
  );
  return next;
}
