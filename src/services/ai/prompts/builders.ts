/**
 * Prompt 构造器：对接七类背景任务 + 分支续写 + 番外。
 *
 * 每个 builder 返回一组 chat messages（OpenAI 兼容格式），
 * 由 provider 调用方决定是否启用 stream / response_format=json_object。
 */

import type { GenreTemplateKey } from '@shared/types/common';
import type {
  BackgroundTaskInputBase,
  BranchContinuationInput,
  CharacterProfile,
  ExtraGenerationInput,
  ObjectProfile,
  RelationGraph,
  StorySummaryData,
  WorldContext,
} from '@shared/types/ai';
import type { Branch, KeyNode } from '@shared/types/story';
import { TEMPLATES, STRUCTURED_OUTPUT_DIRECTIVE } from './templates';
import {
  SCHEMA_BRANCH_CONTINUATION,
  SCHEMA_CHARACTERS,
  SCHEMA_EXTRA,
  SCHEMA_EXTRA_DIRECTIONS,
  SCHEMA_KEY_NODES,
  SCHEMA_OBJECTS,
  SCHEMA_RELATIONS,
  SCHEMA_SUMMARY,
  SCHEMA_WORLD,
} from './schemas';

export type ChatRole = 'system' | 'user' | 'assistant';
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

function header(templateKey: GenreTemplateKey, schema: string): string {
  const tpl = TEMPLATES[templateKey];
  return [
    tpl.persona,
    tpl.style,
    '写作规范：人物对话必须使用「」作为引号，禁止使用“”作引号，保持与原文一致的写作格式。',
    STRUCTURED_OUTPUT_DIRECTIVE,
    `期望的 JSON Schema：\n${schema}`,
  ].join('\n\n');
}

function storyBlock(input: BackgroundTaskInputBase): string {
  return [
    `### 故事元数据`,
    `标题：${input.story.chapter_name}`,
    `作者：${input.story.author_name}`,
    `标签：${input.story.labels.join('、')}`,
    `导语：${input.story.introduction}`,
    ``,
    `### 原文`,
    input.story.content,
  ].join('\n');
}

// ────────────────────────────────────────────────────────────
// 背景任务
// ────────────────────────────────────────────────────────────

export function buildSummaryPrompt(
  input: BackgroundTaskInputBase,
  template: GenreTemplateKey,
): ChatMessage[] {
  return [
    { role: 'system', content: header(template, SCHEMA_SUMMARY) },
    {
      role: 'user',
      content:
        `请基于以下原文，输出 JSON 摘要，包含 story_summary、tone、themes。\n\n${storyBlock(input)}`,
    },
  ];
}

export function buildWorldPrompt(
  input: BackgroundTaskInputBase,
  template: GenreTemplateKey,
): ChatMessage[] {
  return [
    { role: 'system', content: header(template, SCHEMA_WORLD) },
    {
      role: 'user',
      content:
        `请基于以下原文，提炼世界观背景。\nscenes 至少包含 1 个，rules 至少 1 条。\n\n${storyBlock(input)}`,
    },
  ];
}

export function buildCharactersPrompt(
  input: BackgroundTaskInputBase,
  template: GenreTemplateKey,
): ChatMessage[] {
  return [
    { role: 'system', content: header(template, SCHEMA_CHARACTERS) },
    {
      role: 'user',
      content:
        `请基于以下原文，列出所有可识别人物（主角、配角、NPC）。每个角色单独成对象，type 字段标识 main 或 npc。\n\n${storyBlock(input)}`,
    },
  ];
}

export function buildRelationsPrompt(
  input: BackgroundTaskInputBase,
  characters: CharacterProfile[],
  template: GenreTemplateKey,
): ChatMessage[] {
  return [
    { role: 'system', content: header(template, SCHEMA_RELATIONS) },
    {
      role: 'user',
      content: [
        '请基于以下原文与已识别的人物列表，列出主要人物关系。',
        '`from` / `to` 必须使用人物列表里的 character_id。',
        ``,
        `### 人物列表`,
        JSON.stringify(characters.map((c) => ({ character_id: c.character_id, name: c.name, role: c.role })), null, 2),
        ``,
        storyBlock(input),
      ].join('\n'),
    },
  ];
}

export function buildObjectsPrompt(
  input: BackgroundTaskInputBase,
  template: GenreTemplateKey,
): ChatMessage[] {
  return [
    { role: 'system', content: header(template, SCHEMA_OBJECTS) },
    {
      role: 'user',
      content: `请列出原文中出现的关键物品（推动剧情的道具/线索/能力源）。\n\n${storyBlock(input)}`,
    },
  ];
}

export function buildKeyNodesPrompt(
  input: BackgroundTaskInputBase,
  template: GenreTemplateKey,
): ChatMessage[] {
  const genreGuidance = buildGenreKeyNodeGuidance(input.story.labels);
  return [
    { role: 'system', content: header(template, SCHEMA_KEY_NODES) },
    {
      role: 'user',
      content: [
        `请从以下原文中提炼关键节点。`,
        ``,
        `## 什么是关键节点`,
        `关键节点 = 故事中读者可以做出不同选择，并会导致后续剧情产生实质性差异的叙事拐点。`,
        `必须具备：① 两难或多选项 ② 影响后续走向 ③ 读者会真正关心结果。`,
        `不是任何一句话，而是剧情转折、决策点或悬念爆发处。`,
        ``,
        `## 自动识别信号`,
        `1. 叙事结构信号（优先标记）：`,
        `   - 转折词/句式："突然"、"没想到"、"就在这时"、"要么…要么…"、"是…还是…"`,
        `   - 决策动词："犹豫"、"抉择"、"决定"、"选择"、"必须做出决定"`,
        `   - 心理活动：主角内心独白出现矛盾、权衡、假设（"如果…会怎样"）`,
        ``,
        `2. 剧情类型信号（按题材侧重）：`,
        genreGuidance,
        ``,
        `## 筛选流程（必须按顺序执行）`,
        `[1] 先对候选节点做结构识别：转折信号 + 决策动词 + 心理权衡。`,
        `[2] 再做重要性评分：影响后续走向程度、选项可分化程度、情绪强度。`,
        `[3] 最后做过滤：去重、间隔控制、篇幅分段数量控制。`,
        ``,
        `## 硬性门槛（不满足则不要输出该段为节点）`,
        `只有同时满足下列条件的段落，才允许作为 key_nodes 的一项：`,
        `  - 该段能让读者做出「至少两条不同且都合理」的行动/态度选择，且会实质改变后续风险、关系或信息；`,
        `  - 段落内出现叙事岔路信号之一：转折词/决策动词/心理权衡/直接疑问/对峙或秘密揭露等；`,
        `  - 禁止把「纯时间推进、纯场面描写、纯信息交代、他人赶到现场」这类无抉择张力的句子标为节点。`,
        ``,
        `## 筛选规则（必须遵守）`,
        `1. 去重与密度控制：`,
        `   - 两个节点之间至少间隔 200 字（避免过密）`,
        `   - 避开故事开头的纯背景介绍段（前 10% 内容）`,
        `   - 避开结尾的总结/收束段（后 5% 内容）`,
        ``,
        `2. 数量控制：`,
        `   - 短篇（<3000字）：2-4 个`,
        `   - 中篇（3000-8000字）：5-8 个`,
        `   - 长篇（>8000字）：不超过 12 个`,
        ``,
        `3. 重要性分级：`,
        `   - importance = "main"：重大转折（改变主线走向、核心人物命运、重大真相揭露）`,
        `   - importance = "side"：次级线索（丰富人物关系、埋下伏笔、支线选择）`,
        `   - main 节点占比约 60%，side 节点占比约 40%`,
        ``,
        `## 选项生成标准（每个节点 3 个 branch_options）`,
        `1. 差异性：不是"好/更好/最好"，而是不同价值观/风险偏好的真实选择。`,
        `   示例：激进 vs 保守 vs 耍小聪明（或出人意料的第三条路）。`,
        `2. 可行性：符合该角色性格与世界规则，不能出现角色做不出的选择。`,
        `3. 悬念感：每个选项的短期结果不明确，激发读者好奇，想点进去看后果。`,
        `4. 选项必须给出 tone（走向风格），如：稳健、冲突升级、关系扩展、意外反转。`,
        `5. 强关联（硬性）：每个 branch_options[].text 必须是「读者在该段原文岔路口」可采取的具体行动。`,
        `   格式：前半句为选择标题（如"全然听信""反向思考"），后半句用"——"衔接具体描述。`,
        `   严禁在选项中重复原文段落的大段内容，严禁出现"仍处在/语境/仍基于"等废话前缀。`,
        `6. 禁止脱锚：严禁引入该段落未出现的人名、机构、网络舆论、热搜、公关、实锤、风水玄学、`,
        `   或其它现实世界梗；严禁把全书其它段落或摘要里的情节写进选项。`,
        `7. 禁止泛化：不能出现“继续观察/随机应变/先看看情况”等可套用于任意节点的空泛选项。`,
        `8. 人物一致：选项中的行动主体必须在该段原文中已出现或可合理推断（如“她”指代本段已出现女性），`,
        `   不得凭空新增角色。`,
        ``,
        `## 输出要求`,
        `  - 必须绑定原文中的具体段落（paragraph_index 从 0 计数）`,
        `  - anchor_text 取该段落中最具识别度的一句原话（不超过 36 字）`,
        `  - node_type 标注节点类型：turning_point（重大转折）、plot_hook（剧情钩子）、conflict（冲突爆发）、revelation（真相揭露）、emotional（情感抉择）、action（行动决策）`,
        `  - confidence 表示你对这个节点判断的置信度（0.0-1.0）`,
        `  - source 固定为 "original"，depth = 0，parent_branch_id = null`,
        ``,
        storyBlock(input),
      ].join('\n'),
    },
  ];
}

function buildGenreKeyNodeGuidance(labels: string[]): string {
  const genreMap: Record<string, string> = {
    '悬疑': '发现新线索 / 怀疑对象 / 决定追查方向 / 是否相信某人',
    '惊悚': '是否进入危险区域 / 是否揭露秘密 / 是否信任可疑人物',
    '推理': '锁定嫌疑人 / 发现矛盾证据 / 决定质询对象 / 是否公开推断',
    '犯罪': '是否越界 / 同伙背叛 / 是否自首 / 是否灭口',
    '恋爱': '表白 / 拒绝 / 误会发生 / 选择与谁约会 / 是否坦白秘密',
    '言情': '表白时机 / 误会抉择 / 是否原谅 / 感情线分支',
    '甜宠': '是否接受告白 / 吃醋后的反应 / 是否公开关系 / 面对阻碍的选择',
    '冒险': '技能加点 / 战斗策略 / 是否救助队友 / 是否深入险地',
    '战斗': '正面硬刚 / 策略撤退 / 寻求外援 / 牺牲某物换取胜利',
    '玄幻': '修炼方向 / 是否使用禁术 / 师门抉择 / 正邪立场',
    '奇幻': '是否相信超自然提示 / 使用魔法代价 / 异界规则抉择',
    '西游': '是否相信妖怪 / 取经路线 / 师徒矛盾 / 是否动用关系',
    '历史': '站队 / 是否改变历史 / 献计策略 / 忠君 vs 保民',
    '穿越': '暴露身份 / 利用现代知识 / 改变历史走向 / 回到现代 vs 留下',
    '脑洞': '非常规选择 / 打破第四面墙 / 多重现实分支',
    '现实': '职场站队 / 家庭矛盾 / 是否辞职 / 是否揭露真相',
    '家庭': '亲情抉择 / 是否原谅 / 财产分配 / 代际冲突',
    '职场': '项目选择 / 站队 / 公开秘密 / 跳槽 vs 留守',
    '励志': '是否放弃 / 坚持方向 / 是否接受帮助 / 改变策略',
    '爽文': '打脸时机 / 是否隐忍 / 展露实力 / 收服 vs 摧毁对手',
    '宫斗': '站队 / 是否陷害 / 保自己 vs 保盟友 / 争宠策略',
    '宅斗': '嫡庶冲突 / 财产争夺 / 是否反击 / 婚姻选择',
  };

  const matched = labels
    .map((l) => genreMap[l])
    .filter((v): v is string => !!v);

  if (matched.length > 0) {
    return matched.map((g, i) => `   ${i + 1}. ${g}`).join('\n');
  }
  return '   - 通用：面临两难抉择 / 信息获取点 / 人物关系转折点 / 危机应对点';
}

// ────────────────────────────────────────────────────────────
// 分支续写（节点驱动，合并生成正文 + 下一节点 + 分支影响）
// ────────────────────────────────────────────────────────────

export interface BranchContinuationContext {
  summary?: StorySummaryData;
  world?: WorldContext;
  characters?: CharacterProfile[];
  relations?: RelationGraph;
  objects?: ObjectProfile[];
  /** 当前关键节点对象（source_node_id 解析后） */
  source_node?: KeyNode;
  /** 当前链路从根到 source_node 之间的全部分支记录（按顺序） */
  lineage_branches: Branch[];
}

export function buildBranchContinuationPrompt(
  input: BranchContinuationInput,
  ctx: BranchContinuationContext,
  template: GenreTemplateKey,
): ChatMessage[] {
  const constraints = input.constraints ?? {};
  const min = constraints.target_word_count_min ?? 500;
  const max = constraints.target_word_count_max ?? 1200;
  const maxDepth = constraints.max_depth ?? 5;
  const isLastLayer = input.depth >= maxDepth;

  const lineageDigest = ctx.lineage_branches
    .map((b, i) => {
      const excerpt = (b.generated_content ?? '').trim();
      const clip = excerpt.length > 2000 ? `${excerpt.slice(0, 2000)}…（后文已省略）` : excerpt;
      return `  ${i + 1}. [${b.branch_type}] ${b.choice_text}\n     已生成正文：\n${clip || '（尚无正文）'}`;
    })
    .join('\n\n');

  const narrativeTail = input.full_preceding_narrative?.trim();

  const userInstruction = [
    `### 任务`,
    `请基于已生成的世界观、人物、关系网与当前剧情链路，对用户选择的分支进行续写。`,
    ``,
    `### 用户选择`,
    `类型：${input.choice_type}`,
    `内容：${input.choice_text}`,
    input.picked_option
      ? `匹配的预设走向：${input.picked_option.text}（风格：${input.picked_option.tone}）`
      : '（用户自定义输入）',
    ``,
    `### 当前节点`,
    ctx.source_node
      ? `${ctx.source_node.title} | ${ctx.source_node.summary} | 锚点："${ctx.source_node.anchor_text ?? ''}"`
      : '（当前链路末端的续写，无具体锚点）',
    ``,
    `### 当前链路（从根到当前位置的分支摘要 + 已生成正文）`,
    lineageDigest || '（无）',
    ``,
    ...(narrativeTail
      ? [
          `### 已接续正文（读者当前读到的全貌，按阅读顺序）`,
          narrativeTail,
          ``,
          `你必须从以上文字自然结束之后接着写；禁止重复、概括或改写上文已出现的句子与段落。`,
          ``,
        ]
      : []),
    `### 续写要求`,
    `- 续写字数 ${min}-${max} 字。`,
    `- 必须在合适的情节转折处停下，不要在对话或动作中段戛然而止。`,
    `- 在停顿处产出 1 个新关键节点（next_key_node），并给出 2-3 个 branch_options。`,
    `- 当前分支深度 = ${input.depth}，最大深度 = ${maxDepth}。`,
    isLastLayer
      ? '- 已到达最大深度，请自然收束剧情：is_terminal = true，next_key_node = null。'
      : '- 未到最大深度：is_terminal = false，next_key_node 不为空。',
    `- impact 字段必须列出本次分支对人物、关系、世界、物品造成的变化（若无可为空数组）。`,
    narrativeTail
      ? `- 上文「已接续正文」已包含全部语境，请只写新增续写段落，不要复述上文。`
      : `- 不要重复原文已经讲过的剧情，从用户的选择处自然衔接。`,
    ``,
    `### 输出格式（极其重要）`,
    `整段回复只能是「一个」合法 JSON 对象；不要用 markdown 代码块包裹；不要在 JSON 前后写任何说明、标题或故事片段。`,
    `所有叙事正文必须写在 JSON 的 generated_content 字符串字段内（字符串内换行用 \\n 转义），禁止在 JSON 大括号之外输出小说正文。`,
  ].join('\n');

  const contextDigest = [
    ctx.summary ? `### 故事摘要\n${ctx.summary.story_summary}\n基调：${ctx.summary.tone}` : null,
    ctx.world
      ? `### 世界观\n${ctx.world.world_summary}\n核心冲突：${ctx.world.core_conflict}\n规则：\n${ctx.world.rules.map((r) => `  - ${r}`).join('\n')}`
      : null,
    ctx.characters && ctx.characters.length
      ? `### 人物\n${ctx.characters
          .map(
            (c) =>
              `  - [${c.character_id}] ${c.name}（${c.role}）：${c.personality}｜动机：${c.motivation}`,
          )
          .join('\n')}`
      : null,
    ctx.relations && ctx.relations.relations.length
      ? `### 关系网\n${ctx.relations.relations
          .map((r) => `  - ${r.from} → ${r.to}：${r.relation}（${r.intensity ?? ''}）`)
          .join('\n')}`
      : null,
    ctx.objects && ctx.objects.length
      ? `### 物品\n${ctx.objects.map((o) => `  - [${o.object_id}] ${o.name}：${o.description}`).join('\n')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  return [
    {
      role: 'system',
      content: header(template, SCHEMA_BRANCH_CONTINUATION),
    },
    { role: 'user', content: `${contextDigest}\n\n${userInstruction}` },
  ];
}

// ────────────────────────────────────────────────────────────
// 番外
// ────────────────────────────────────────────────────────────

export function buildExtraDirectionsPrompt(
  characters: CharacterProfile[],
  summary: StorySummaryData | undefined,
  template: GenreTemplateKey,
): ChatMessage[] {
  return [
    { role: 'system', content: header(template, SCHEMA_EXTRA_DIRECTIONS) },
    {
      role: 'user',
      content: [
        '请基于以下故事摘要与人物，给出 2-3 个番外方向。',
        '每个方向：',
        '  - title 必须以"番外："开头',
        '  - hook 控制在 1 句话内，描述该番外的看点',
        '',
        '### 故事摘要',
        summary?.story_summary ?? '（无）',
        '',
        '### 主要人物',
        characters
          .filter((c) => c.type === 'main')
          .map((c) => `  - ${c.name}（${c.role}）：${c.personality}`)
          .join('\n'),
      ].join('\n'),
    },
  ];
}

export function buildExtraPrompt(
  input: ExtraGenerationInput,
  ctx: BranchContinuationContext,
  template: GenreTemplateKey,
): ChatMessage[] {
  const min = input.constraints?.target_word_count_min ?? 2000;
  const max = input.constraints?.target_word_count_max ?? 5000;

  const directionText = input.picked_direction
    ? `${input.picked_direction.title}：${input.picked_direction.hook}`
    : `${input.custom_title ?? '番外'}：${input.custom_hook ?? '（用户自定义）'}`;

  return [
    { role: 'system', content: header(template, SCHEMA_EXTRA) },
    {
      role: 'user',
      content: [
        '请基于以下背景生成一篇完整番外。',
        `字数控制在 ${min}-${max} 字之间，必须在该区间内自然收束，不要被截断。`,
        '番外不在中间分支，一次写到结束。',
        '',
        '### 方向',
        directionText,
        '',
        '### 已生成的世界观与人物',
        ctx.world ? `世界观：${ctx.world.world_summary}` : '',
        ctx.characters?.map((c) => `${c.name}：${c.personality}`).join('\n') ?? '',
        '',
        'extra_title 必须以"番外："开头。',
      ].join('\n'),
    },
  ];
}
