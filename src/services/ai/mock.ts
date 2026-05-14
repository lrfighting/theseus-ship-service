/**
 * Mock Provider：调试与离线开发用。
 *
 * 行为：
 *  - complete() 根据 messages 末尾的 schema hint 返回结构化 JSON（用一组通用 stub 数据）。
 *  - stream() 把同样的 JSON 字符串按字切流，模拟 SSE 节奏。
 *
 * 实际项目接入 Kimi 后只需把 AI_PROVIDER 改成 kimi。
 */

import type {
  ChatCompletionOptions,
  ChatCompletionResult,
  StoryAIProvider,
  StreamChunk,
} from './provider';
import type { ChatMessage } from './prompts/builders';
import { chunkText } from '../../utils/sse';

function detectTaskFromSchema(messages: ChatMessage[]): string {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  if (system.includes('story_summary')) return 'summary';
  if (system.includes('world_summary')) return 'world';
  if (system.includes('"characters"')) return 'characters';
  if (system.includes('"relations"')) return 'relations';
  if (system.includes('"objects"')) return 'objects';
  if (system.includes('"key_nodes"')) return 'key_nodes';
  if (system.includes('"directions"')) return 'extra_directions';
  if (system.includes('extra_title')) return 'extra';
  if (system.includes('next_key_node')) return 'branch_continuation';
  return 'unknown';
}

function summaryMock(userText: string) {
  return {
    story_summary: userText.includes('秦始皇')
      ? '一个穿越者凭借系统好感度兑换帮助秦始皇启动登月计划，引发古今碰撞的爽文叙事。'
      : '主角在一连串看似日常的事件中发现关键秘密，被迫做出抉择。',
    tone: '脑洞 / 轻喜',
    themes: ['穿越', '权力', '科技'],
  };
}

function worldMock() {
  return {
    world_summary: '故事发生在以秦朝宫廷为底色的架空时空，主角凭借"好感度系统"调用近现代技术与思想。',
    core_conflict: '主角与朝堂权臣对"是否登月"这一异想天开计划的拉锯。',
    tone: '脑洞',
    scenes: [
      { scene_id: 'scene_palace', name: '咸阳宫', time: '公元前 220 年', description: '皇权核心、人物常驻、权斗暗涌' },
      { scene_id: 'scene_lab', name: '匠人作坊', time: '夜晚', description: '工匠们围着登月草图反复演算' },
    ],
    rules: ['好感度可兑换跨时代物品', '兑换的物品必须有合理出处掩护', '秦始皇的决策权高于一切'],
  };
}

function charactersMock() {
  return {
    characters: [
      {
        character_id: 'char_self',
        name: '我',
        role: '主角',
        type: 'main',
        personality: '机灵、滑跪、善于借势',
        motivation: '不被识破并完成登月计划',
        speech_style: '现代感强，常用网络梗',
        background: '现代穿越者，自带好感度系统',
      },
      {
        character_id: 'char_qsh',
        name: '秦始皇',
        role: '皇帝',
        type: 'main',
        personality: '雄心勃勃、控制欲强',
        motivation: '让大秦千秋万代',
        speech_style: '威严克制、句短',
        background: '一统六国的始皇帝',
      },
      {
        character_id: 'char_lisi',
        name: '李斯',
        role: '丞相',
        type: 'npc',
        personality: '谨慎多疑',
        motivation: '稳固自身相位',
        speech_style: '文绉绉、咳嗽多',
        background: '法家代表，秦廷重臣',
      },
    ],
  };
}

function relationsMock() {
  return {
    relations: [
      { from: 'char_self', to: 'char_qsh', relation: '臣属/伙伴', intensity: 'high', description: '凭好感度获得信任' },
      { from: 'char_lisi', to: 'char_self', relation: '猜忌', intensity: 'mid', description: '担心被夺权' },
    ],
  };
}

function objectsMock() {
  return {
    objects: [
      {
        object_id: 'obj_map',
        name: '世界地图',
        type: 'key_item',
        description: '现代版世界地图，提升好感度的关键',
        current_owner: 'char_qsh',
        story_role: '决策依据',
      },
      {
        object_id: 'obj_rocket_blueprint',
        name: '登月草图',
        type: 'key_item',
        description: '主角手绘的简易火箭草图',
        current_owner: 'char_self',
        story_role: '推动登月计划',
      },
    ],
  };
}

function keyNodesMock(content: string) {
  // 取原文段落数作为锚点上限。
  const paragraphs = content.split(/\n+/).filter((s) => s.trim());
  const total = paragraphs.length;
  if (total === 0) return { key_nodes: [] };

  // 按内容长度智能分配节点数量
  const wordCount = content.length;
  let targetCount: number;
  if (wordCount < 3000) targetCount = 3;
  else if (wordCount < 8000) targetCount = 5;
  else targetCount = Math.min(8, Math.floor(total / 5));

  const nodeTemplates = [
    { importance: 'main', title: '命运的岔路口', node_type: 'turning_point' },
    { importance: 'main', title: '真相浮出水面', node_type: 'revelation' },
    { importance: 'side', title: '情感的抉择', node_type: 'emotional' },
    { importance: 'main', title: '危机爆发', node_type: 'conflict' },
    { importance: 'side', title: '隐藏的线索', node_type: 'plot_hook' },
    { importance: 'main', title: '行动的时刻', node_type: 'action' },
    { importance: 'side', title: '意外的转折', node_type: 'turning_point' },
    { importance: 'side', title: '信任的裂痕', node_type: 'emotional' },
  ];

  const picks: Array<{ paragraph_index: number; importance: string; title: string; node_type: string }> = [];
  const step = Math.max(1, Math.floor(total / (targetCount + 1)));
  for (let i = 0; i < targetCount; i++) {
    const idx = Math.min(Math.max(step * (i + 1), 1), total - 2);
    const tpl = nodeTemplates[i % nodeTemplates.length];
    picks.push({ paragraph_index: idx, importance: tpl.importance, title: tpl.title, node_type: tpl.node_type });
  }

  const optionTemplates = [
    [
      { text: '直面冲突，主动出击，哪怕代价惨重', tone: '冲突升级' },
      { text: '暂避锋芒，暗中积蓄力量等待时机', tone: '稳健' },
      { text: '另辟蹊径，用出人意料的方式破局', tone: '意外反转' },
    ],
    [
      { text: '相信直觉，沿着最危险的线索追查到底', tone: '冒险' },
      { text: '保持冷静，先收集更多信息再做判断', tone: '稳健' },
      { text: '抛出诱饵，引蛇出洞让对方自露马脚', tone: '策略' },
    ],
    [
      { text: '坦诚相待，把所有秘密和盘托出', tone: '关系扩展' },
      { text: '有所保留，只透露部分真相保护自己', tone: '稳健' },
      { text: '反向试探，用谎言测试对方的真实意图', tone: '意外反转' },
    ],
  ];

  return {
    key_nodes: picks.map((p, i) => {
      const anchor = paragraphs[p.paragraph_index] ?? '';
      const opts = optionTemplates[i % optionTemplates.length];
      return {
        node_id: `node_${i + 1}`,
        title: p.title,
        summary: `在原文第${p.paragraph_index + 1}段出现关键抉择，影响后续${p.importance === 'main' ? '主线' : '支线'}走向`,
        importance: p.importance,
        node_type: p.node_type,
        source: 'original',
        depth: 0,
        parent_branch_id: null,
        paragraph_index: p.paragraph_index,
        char_range: [0, Math.min(anchor.length, 36)],
        anchor_text: anchor.slice(0, 36) || '（该段落为关键转折点）',
        quote_hash: `qh_${i + 1}`,
        confidence: 0.75 + Math.random() * 0.2,
        branch_options: opts.map((opt, j) => ({
          option_id: `node_${i + 1}_opt_${String.fromCharCode(97 + j)}`,
          text: opt.text,
          tone: opt.tone,
        })),
      };
    }),
  };
}

function branchContinuationMock(userText: string, opts: { branchId?: string; depth?: number; lastLayer?: boolean }) {
  const depth = opts.depth ?? 1;
  const isLast = !!opts.lastLayer;
  const generated = [
    `他短暂地停顿了一下，把目光从案上移开——这并不是事先排练的反应。`,
    `空气里有种说不清的味道，像是冷却的金属，又像是某种正在悄然燃烧的纸张。`,
    `${userText.replace(/[，。：；\n]+/g, '')}的想法浮上来，又被他强行按住，按到比"皇命如山"更深的位置。`,
    `他抬起头，目光落在角落里的那张草图上：是的，决定要在这里发生。`,
  ].join('\n');
  return {
    generated_content: generated,
    summary: '主角短暂权衡后，决定继续推进当前路线。',
    next_key_node: isLast
      ? null
      : {
          node_id: `node_branch_${opts.branchId ?? 'x'}_n1`,
          title: '匠人作坊的低语',
          summary: '匠人开始质疑这份草图，主角必须做出回应。',
          importance: 'main',
          node_type: 'turning_point',
          source: 'ai_continuation',
          depth,
          parent_branch_id: opts.branchId ?? null,
          ai_paragraph_id: 'ai_para_1',
          anchor_text: '他抬起头，目光落在角落里的那张草图上',
          branch_options: [
            { option_id: 'opt_workshop_a', text: '直面匠人的质疑，公开解释', tone: '坦诚' },
            { option_id: 'opt_workshop_b', text: '私下安抚，承诺利益', tone: '权术' },
            { option_id: 'opt_workshop_c', text: '请秦始皇出面震慑', tone: '借势' },
          ],
        },
    impact: {
      character_changes: [
        { character_id: 'char_self', before: '试探', after: '坚定推进', trigger: userText },
      ],
      relation_changes: [],
      new_events: ['草图在更小的圈子里流传开来'],
      object_changes: [],
    },
    is_terminal: isLast,
  };
}

function extraDirectionsMock() {
  return {
    directions: [
      { direction_id: 'ed_1', title: '番外：秦始皇的日常生活', hook: '镜头转向皇帝的一天三餐与午后小睡' },
      { direction_id: 'ed_2', title: '番外：匠人的最后一晚', hook: '登月发射前夜，一位工匠的犹豫与守护' },
      { direction_id: 'ed_3', title: '番外：李斯写给后人的信', hook: '丞相在密室里口述自己对这场闹剧的真实评价' },
    ],
  };
}

function extraMock(userTitle: string) {
  return {
    extra_title: userTitle.startsWith('番外') ? userTitle : `番外：${userTitle || '尘埃之外'}`,
    extra_summary: '一段不影响主线的支线小品。',
    generated_content: [
      '清晨的咸阳宫还没有完全醒来，廊下的露珠落在青砖上，碎成细碎的星光。',
      '秦始皇撑着案几，第三次端起那盏小米粥。他不饿，但他需要这一刻"什么都不做"。',
      '远远地，工匠的锤声响起，又很快归于沉默。',
      '殿门外，宦官低声禀报：陛下，那位先生求见。',
      '皇帝放下粥碗，露出了一个少见的笑意：让他进来。',
    ].join('\n'),
  };
}

export const mockProvider: StoryAIProvider = {
  name: 'mock',
  defaultModel: 'mock-1',

  async complete(messages, opts = {}): Promise<ChatCompletionResult> {
    const text = pickMockText(messages);
    return { text, model: opts.model ?? 'mock-1' };
  },

  async *stream(messages, opts = {}): AsyncIterable<StreamChunk> {
    const text = pickMockText(messages);
    for (const chunk of chunkText(text, 12)) {
      await new Promise((r) => setTimeout(r, 35));
      yield { text: chunk, done: false };
    }
    yield { text: '', done: true };
  },
};

function pickMockText(messages: ChatMessage[]): string {
  const task = detectTaskFromSchema(messages);
  const userText = messages
    .filter((m) => m.role === 'user')
    .map((m) => m.content)
    .join('\n');

  // 从 user 内容里粗暴抽出原文（如果有），供 key_nodes 锚定段落
  const contentMatch = /### 原文\n([\s\S]+?)(?:\n###|\n*$)/.exec(userText);
  const rawContent = contentMatch?.[1] ?? '';

  // 从 user 内容里抽 branch_id / depth
  const branchIdMatch = /branch_id"?\s*[:：]?\s*"?([\w]+)"?/i.exec(userText);
  const depthMatch = /当前分支深度\s*=\s*(\d+)/i.exec(userText);
  const isLastLayerMatch = /已到达最大深度/.exec(userText);

  let payload: unknown;
  switch (task) {
    case 'summary':
      payload = summaryMock(userText);
      break;
    case 'world':
      payload = worldMock();
      break;
    case 'characters':
      payload = charactersMock();
      break;
    case 'relations':
      payload = relationsMock();
      break;
    case 'objects':
      payload = objectsMock();
      break;
    case 'key_nodes':
      payload = keyNodesMock(rawContent);
      break;
    case 'extra_directions':
      payload = extraDirectionsMock();
      break;
    case 'extra':
      payload = extraMock(userText.match(/番外：\s*([^\n]+)/)?.[1] ?? '');
      break;
    case 'branch_continuation':
      payload = branchContinuationMock(userText, {
        branchId: branchIdMatch?.[1],
        depth: depthMatch ? Number(depthMatch[1]) : 1,
        lastLayer: !!isLastLayerMatch,
      });
      break;
    default:
      payload = { error: 'unknown_task' };
  }
  return JSON.stringify(payload);
}
