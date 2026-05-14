/**
 * 知乎盐言故事相关的实体类型，前后端共享。
 *
 * 注意：
 * - `content_hash` 是 V1.3 全部 AI 缓存键的核心字段，必须由服务端在拿到原文后计算并稳定返回。
 * - `StoryDetail.content` 保持知乎接口原样字符串（段落用 \n 分隔），不在共享类型里预解析。
 */

export interface StorySummary {
  work_id: string;
  title: string;
  artwork: string;
  tab_artwork: string;
  description: string;
  labels: string[];
}

export interface StoryDetail {
  work_id: string;
  chapter_name: string;
  author_avatar: string;
  author_name: string;
  labels: string[];
  introduction: string;
  content: string;
  content_hash: string;
}

/**
 * 关键节点：V1.3 同时支持原文节点和 AI 续写节点。
 */
export type KeyNodeSource = 'original' | 'ai_continuation';

export interface BranchOption {
  option_id: string;
  text: string;
  tone: string;
}

export interface KeyNode {
  node_id: string;
  title: string;
  summary: string;
  importance: 'main' | 'side';
  node_type: string;
  source: KeyNodeSource;
  /** 当前节点所在分支链路的深度。原文节点 = 0。 */
  depth: number;
  /** 若 source = ai_continuation，则记录所属 Branch ID。 */
  parent_branch_id: string | null;

  // —— 仅 original 节点 ——
  paragraph_index?: number;
  char_range?: [number, number];
  anchor_text?: string;
  quote_hash?: string;
  confidence?: number;

  // —— 仅 ai_continuation 节点 ——
  ai_paragraph_id?: string;

  branch_options: BranchOption[];
}

export interface KeyNodeBundle {
  work_id: string;
  content_hash: string;
  key_nodes: KeyNode[];
}

/**
 * 分支记录。同一个数据结构覆盖三种生成形态：
 *  - node_branch：原文/续写中关键节点的分叉
 *  - continuation：当前链路末端的续写
 *  - extra：标题级番外
 */
export type BranchType = 'node_branch' | 'continuation' | 'extra';
export type BranchStatus =
  | 'queued'
  | 'pending'
  | 'generating'
  | 'success'
  | 'failed'
  | 'cancelled';

export interface BranchImpactCharacterChange {
  character_id: string;
  before: string;
  after: string;
  trigger?: string;
}

export interface BranchImpactRelationChange {
  from: string;
  to: string;
  before: string;
  after: string;
}

export interface BranchImpactObjectChange {
  object_id: string;
  before: string;
  after: string;
}

export interface BranchImpact {
  branch_id: string;
  character_changes: BranchImpactCharacterChange[];
  relation_changes: BranchImpactRelationChange[];
  new_events: string[];
  object_changes: BranchImpactObjectChange[];
}

export interface Branch {
  branch_id: string;
  branch_type: BranchType;
  source_node_id?: string;
  parent_branch_id: string | null;
  depth: number;

  /** 用户的选择：preset = 选择 AI 预设；custom = 用户自定义输入 */
  choice_type?: 'preset' | 'custom';
  choice_text: string;

  /** 番外才有 */
  extra_title?: string;
  extra_summary?: string;

  status: BranchStatus;
  generated_content: string;
  summary?: string;

  /** 续写完成后产出的下一个关键节点 ID（番外永远为 null）。 */
  next_node_id: string | null;
  /** 是否为该链路的终止节点 */
  is_terminal: boolean;

  created_at: number;
  updated_at?: number;
  model?: string;
  prompt_version?: string;
}

/**
 * 一条剧情链路（从根节点到某叶子分支）。
 * 用于会话内"切换链路"的可视化与渲染。
 */
export interface Lineage {
  lineage_id: string;
  /** 从根到叶子的 branch_id 列表。空数组表示纯原文链路。 */
  branch_ids: string[];
  created_at: number;
  updated_at: number;
}

/**
 * 单次会话（用户级，浏览器侧持久化）。
 */
export interface StorySession {
  session_id: string;
  work_id: string;
  base_content_hash: string;
  current_branch_id: string | null;
  current_lineage_id: string | null;
  lineages: Lineage[];
  branches: Record<string, Branch>;
  key_nodes: Record<string, KeyNode>;
  branch_impacts: Record<string, BranchImpact>;
  created_at: number;
  updated_at: number;
}
