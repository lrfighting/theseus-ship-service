/**
 * 与 V1.3 PRD §5.3 / §5.5 对齐的结构化输出 schema。
 * 这些 schema 用于：
 *  1. 注入到 Prompt 中告知模型期望的字段；
 *  2. 在服务端做轻量校验（providers/parseStructuredOutput）。
 *
 * 不引入 zod / ajv 等额外依赖；以 TS 类型 + 字面对象描述即可。
 */

export const SCHEMA_SUMMARY = `
{
  "story_summary": "string",
  "tone": "string",
  "themes": ["string"]
}`.trim();

export const SCHEMA_WORLD = `
{
  "world_summary": "string",
  "core_conflict": "string",
  "tone": "string",
  "scenes": [
    { "scene_id": "string", "name": "string", "time": "string", "description": "string" }
  ],
  "rules": ["string"]
}`.trim();

export const SCHEMA_CHARACTERS = `
{
  "characters": [
    {
      "character_id": "string",
      "name": "string",
      "role": "string",
      "type": "main" | "npc",
      "personality": "string",
      "motivation": "string",
      "speech_style": "string",
      "background": "string",
      "appearance": "string"
    }
  ]
}`.trim();

export const SCHEMA_RELATIONS = `
{
  "relations": [
    {
      "from": "character_id",
      "to": "character_id",
      "relation": "string",
      "intensity": "low" | "mid" | "high",
      "description": "string"
    }
  ]
}`.trim();

export const SCHEMA_OBJECTS = `
{
  "objects": [
    {
      "object_id": "string",
      "name": "string",
      "type": "string",
      "description": "string",
      "current_owner": "string",
      "story_role": "string"
    }
  ]
}`.trim();

export const SCHEMA_KEY_NODES = `
{
  "key_nodes": [
    {
      "node_id": "string",
      "title": "string（节点标题，10字以内，概括核心抉择）",
      "summary": "string（节点摘要，40字以内，说明这个抉择的影响）",
      "importance": "main" | "side",
      "node_type": "string: turning_point | plot_hook | conflict | revelation | emotional | action",
      "source": "original",
      "depth": 0,
      "parent_branch_id": null,
      "paragraph_index": 0,
      "char_range": [0, 0],
      "anchor_text": "string（该段落中最具识别度的原话，不超过36字）",
      "quote_hash": "string",
      "confidence": "number (0.0-1.0，你对该节点判断的置信度)",
      "branch_options": [
        { "option_id": "string", "text": "string（选择标题——具体描述，标题5-12字体现价值观/风险偏好，描述20-40字补充行动细节，用'——'分隔，严禁重复原文）", "tone": "string（走向风格，如：稳健、冲突升级、关系扩展、意外反转）" }
      ]
    }
  ]
}`.trim();

export const SCHEMA_BRANCH_CONTINUATION = `
{
  "generated_content": "string",
  "summary": "string",
  "next_key_node": {
    "node_id": "string",
    "title": "string",
    "summary": "string",
    "importance": "main" | "side",
    "node_type": "string",
    "source": "ai_continuation",
    "depth": <integer>,
    "parent_branch_id": "<branch_id>",
    "ai_paragraph_id": "string",
    "anchor_text": "string",
    "branch_options": [
      { "option_id": "string", "text": "string", "tone": "string" }
    ]
  } | null,
  "impact": {
    "character_changes": [
      { "character_id": "string", "before": "string", "after": "string", "trigger": "string" }
    ],
    "relation_changes": [
      { "from": "string", "to": "string", "before": "string", "after": "string" }
    ],
    "new_events": ["string"],
    "object_changes": [
      { "object_id": "string", "before": "string", "after": "string" }
    ]
  },
  "is_terminal": false
}`.trim();

export const SCHEMA_EXTRA_DIRECTIONS = `
{
  "directions": [
    { "direction_id": "string", "title": "番外：xxx", "hook": "string" }
  ]
}`.trim();

export const SCHEMA_EXTRA = `
{
  "extra_title": "番外：xxx",
  "extra_summary": "string",
  "generated_content": "string"
}`.trim();


