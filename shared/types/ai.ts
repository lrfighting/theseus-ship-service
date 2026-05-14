/**
 * AI 任务相关的输入/输出类型，前后端共享。
 *
 * 命名约定：
 *  - 同步任务（一次性返回）：xxxInput / xxxResult
 *  - 流式任务（SSE）：xxxInput，结果通过 SSE 事件流给出，事件类型见 sse.ts
 *
 * 七类背景任务（P0 全部静默生成）：
 *   summary | world | characters | relations | objects | key_nodes
 *   （注：characters 包含 main + NPC）
 */

import type { GenreTemplateKey, ModelId, PromptVersion } from './common';
import type {
  Branch,
  BranchImpact,
  BranchOption,
  BranchType,
  KeyNode,
  KeyNodeBundle,
  StoryDetail,
} from './story';

// ─────────────────────────────────────────────────────────────
// 背景任务（七类）
// ─────────────────────────────────────────────────────────────

export type BackgroundTaskType =
  | 'summary'
  | 'world'
  | 'characters'
  | 'relations'
  | 'objects'
  | 'key_nodes';

export interface BackgroundTaskInputBase {
  work_id: string;
  content_hash: string;
  story: Pick<
    StoryDetail,
    'chapter_name' | 'author_name' | 'labels' | 'introduction' | 'content'
  >;
  /** 强制重新生成（运营/调试），默认 false */
  force_refresh?: boolean;
  /** 覆盖默认模板（一般不传） */
  template_key?: GenreTemplateKey;
}

export interface BackgroundTaskMeta {
  cache_key: string;
  source: 'memory' | 'file' | 'cdn' | 'live';
  model: ModelId;
  prompt_version: PromptVersion;
  template_key: GenreTemplateKey;
  generated_at: number;
}

export interface BackgroundTaskResponse<TType extends BackgroundTaskType> {
  task_type: TType;
  data: BackgroundTaskDataMap[TType];
  meta: BackgroundTaskMeta;
}

// —— 各任务返回的数据结构 ——

export interface StorySummaryData {
  work_id: string;
  content_hash: string;
  story_summary: string;
  tone: string;
  themes: string[];
}

export interface WorldScene {
  scene_id: string;
  name: string;
  time: string;
  description: string;
}

export interface WorldContext {
  work_id: string;
  world_summary: string;
  core_conflict: string;
  tone: string;
  scenes: WorldScene[];
  rules: string[];
}

export interface CharacterProfile {
  character_id: string;
  name: string;
  role: string;
  /** main = 主要角色 / npc = 配角 */
  type: 'main' | 'npc';
  personality: string;
  motivation: string;
  speech_style: string;
  background: string;
  appearance?: string;
}

export interface RelationGraphEdge {
  from: string;
  to: string;
  relation: string;
  intensity?: 'low' | 'mid' | 'high';
  description?: string;
}

export interface RelationGraph {
  work_id: string;
  relations: RelationGraphEdge[];
}

export interface ObjectProfile {
  object_id: string;
  name: string;
  type: string;
  description: string;
  current_owner?: string;
  story_role?: string;
}

export interface BackgroundTaskDataMap {
  summary: StorySummaryData;
  world: WorldContext;
  characters: CharacterProfile[];
  relations: RelationGraph;
  objects: ObjectProfile[];
  key_nodes: KeyNodeBundle;

}

/**
 * 全套背景信息聚合（前端故事档案侧栏一次性拉取的形态）。
 */
export interface StoryArchiveBundle {
  work_id: string;
  content_hash: string;
  template_key: GenreTemplateKey;
  summary?: StorySummaryData;
  world?: WorldContext;
  characters?: CharacterProfile[];
  relations?: RelationGraph;
  objects?: ObjectProfile[];
  key_nodes?: KeyNodeBundle;
  /** 服务端按 task_type 维度报告的就绪状态 */
  readiness: Record<BackgroundTaskType, 'pending' | 'ready' | 'failed'>;
}

// ─────────────────────────────────────────────────────────────
// 分支续写（节点驱动，流式）
// ─────────────────────────────────────────────────────────────

export interface BranchContinuationInput {
  /** 客户端预先生成的 branch_id，方便流期间双向引用 */
  branch_id: string;
  work_id: string;
  content_hash: string;
  branch_type: Extract<BranchType, 'node_branch' | 'continuation'>;

  /** 源关键节点 ID（continuation 末端续写时可为空） */
  source_node_id?: string;

  /** 父分支 ID，根分支为 null */
  parent_branch_id: string | null;
  /** 即将生成的分支深度（父分支 depth + 1） */
  depth: number;
  /** 当前分支链路从根到 source_node_id 的所有 branch_id（按顺序）。供模型构建上下文。 */
  lineage_branch_ids: string[];

  choice_type: 'preset' | 'custom';
  choice_text: string;
  /** 选中的 AI 预设选项（custom 时为空） */
  picked_option?: BranchOption;

  constraints?: {
    target_word_count_min?: number;
    target_word_count_max?: number;
    max_depth?: number;
  };

  /** 可选：客户端可以传一个 idempotency key 触发幂等续写 */
  idempotency_key?: string;

  /** 当前链路已提交分支（含 generated_content），供服务端构造语境 */
  lineage_branches?: Branch[];
  /** 读者已读到的原文可见部分 + 已接受续写，按顺序拼接；续写必须紧接在此之后 */
  full_preceding_narrative?: string;
  /** 客户端解析后的当前关键节点（会话态，供 prompt 锚点） */
  source_node?: KeyNode;
}

export interface BranchContinuationResult {
  branch: Branch;
  next_key_node: KeyNode | null;
  impact: BranchImpact;
  meta: {
    model: ModelId;
    prompt_version: PromptVersion;
    template_key: GenreTemplateKey;
    is_terminal: boolean;
  };
}

// ─────────────────────────────────────────────────────────────
// 番外（标题级分支，流式）
// ─────────────────────────────────────────────────────────────

export interface ExtraDirection {
  direction_id: string;
  title: string;
  hook: string;
}

export interface ExtraDirectionsInput {
  work_id: string;
  content_hash: string;
}

export interface ExtraDirectionsResult {
  directions: ExtraDirection[];
}

export interface ExtraGenerationInput {
  branch_id: string;
  work_id: string;
  content_hash: string;
  choice_type: 'preset' | 'custom';
  /** 选中的方向（preset 时携带） */
  picked_direction?: ExtraDirection;
  /** 自定义方向的标题与简介（custom 时携带） */
  custom_title?: string;
  custom_hook?: string;
  constraints?: {
    target_word_count_min?: number;
    target_word_count_max?: number;
  };
  idempotency_key?: string;
}

export interface ExtraResult {
  branch: Branch;
  meta: {
    model: ModelId;
    prompt_version: PromptVersion;
    template_key: GenreTemplateKey;
  };
}

// ─────────────────────────────────────────────────────────────
// 任务编排状态（前端可查询）
// ─────────────────────────────────────────────────────────────

export interface OrchestratorTaskStatus {
  task_id: string;
  task_type: BackgroundTaskType | 'branch_continuation' | 'extra';
  state: 'queued' | 'running' | 'completed' | 'failed';
  queued_at: number;
  started_at?: number;
  completed_at?: number;
  /** 用于 UI 进度（如分支等待背景时 n/m 已就绪） */
  upstream_total?: number;
  upstream_ready?: number;
  error?: { code: string; message: string };
}

export interface BranchQueueState {
  work_id: string;
  background_total: number;
  background_ready: number;
  background_failed: number;
  ready_to_branch: boolean;
}

// ─────────────────────────────────────────────────────────────
// 错误
// ─────────────────────────────────────────────────────────────

export interface AiErrorPayload {
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}


