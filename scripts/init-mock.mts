/**
 * init-mock.mts
 *
 * 预取脚本：从知乎盐言 API 获取所有故事数据，并用 AI 预分析所有背景信息，
 * 保存为本地 mock 文件，供 ZHIHU_USE_FIXTURE=1 模式下离线演示使用。
 *
 * 运行方式：
 *   npm run init-mock
 *
 * 前置条件（.env 或 .env.local）：
 *   ZHIHU_API_APP_KEY=xxx
 *   ZHIHU_API_APP_SECRET=xxx
 *   KIMI_API_KEY=xxx
 *   AI_PROVIDER=kimi
 *
 * 输出：
 *   mocks/zhihu-list.json                  ← 故事列表
 *   mocks/zhihu-details/{work_id}.json     ← 各故事详情
 *   .cache/yyan-ai/stories/...             ← AI 分析缓存（orchestrator 自动写入）
 */

// config.ts 会在模块初始化时自动加载 .env / .env.local，无需额外处理
import { promises as fs } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchListLive, fetchDetailLive } from '../src/services/zhihu.js';
import { contentHash } from '../src/utils/hash.js';
import {
  getOrCreateSummary,
  getOrCreateWorld,
  getOrCreateCharacters,
  getOrCreateRelations,
  getOrCreateObjects,
  getOrCreateKeyNodes,
} from '../src/services/orchestrator/index.js';
import type { StoryDetail, StorySummary } from '@shared/types/story';
import type { BackgroundTaskInputBase } from '@shared/types/ai';

// ──────────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const MOCK_DIR = resolve(ROOT, 'mocks');

async function writeJson(path: string, data: unknown) {
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
}

function buildInput(detail: StoryDetail): BackgroundTaskInputBase {
  return {
    work_id: detail.work_id,
    content_hash: detail.content_hash,
    story: {
      chapter_name: detail.chapter_name,
      author_name: detail.author_name,
      labels: detail.labels,
      introduction: detail.introduction,
      content: detail.content,
    },
    force_refresh: true,
  };
}

function log(msg: string) {
  const ts = new Date().toLocaleTimeString('zh-CN');
  console.log(`[${ts}] ${msg}`);
}

function logError(label: string, err: unknown) {
  const ts = new Date().toLocaleTimeString('zh-CN');
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[${ts}] ❌ ${label}: ${msg}`);
}

// ──────────────────────────────────────────────────────────────
// 单个故事的 AI 背景分析（串行，防止并发过多）
// ──────────────────────────────────────────────────────────────

async function analyzeStory(detail: StoryDetail): Promise<{ ok: number; failed: number }> {
  const input = buildInput(detail);
  let ok = 0;
  let failed = 0;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      ok++;
      log(`    ✓ ${label}`);
    } catch (err) {
      failed++;
      logError(`    ${label}`, err);
    }
  };

  await run('summary',    () => getOrCreateSummary(input));
  await run('world',      () => getOrCreateWorld(input));
  await run('characters', () => getOrCreateCharacters(input));
  await run('relations',  () => getOrCreateRelations(input));
  await run('objects',    () => getOrCreateObjects(input));
  await run('key_nodes',  () => getOrCreateKeyNodes(input));

  return { ok, failed };
}

// ──────────────────────────────────────────────────────────────
// 主流程
// ──────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  盐言·忒修斯之船  Mock 数据初始化');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');

  // ── Step 1: 获取故事列表 ──────────────────────────────────
  log('Step 1: 从知乎 API 获取故事列表...');
  let stories: StorySummary[];
  try {
    stories = await fetchListLive();
    await writeJson(resolve(MOCK_DIR, 'zhihu-list.json'), stories);
    log(`  ✓ ${stories.length} 个故事 → mocks/zhihu-list.json`);
  } catch (err) {
    logError('获取故事列表失败，脚本终止', err);
    process.exit(1);
  }

  // ── Step 2: 逐个故事：详情 + AI 分析 ─────────────────────
  let totalDetailOk = 0;
  let totalDetailFail = 0;
  let totalAnalysisOk = 0;
  let totalAnalysisFail = 0;

  for (let i = 0; i < stories.length; i++) {
    const summary = stories[i]!;
    console.log('');
    log(`Step 2.${i + 1}/${stories.length}: 「${summary.title}」（${summary.work_id}）`);

    // 获取详情
    let detail: StoryDetail;
    try {
      const raw = await fetchDetailLive(summary.work_id);
      detail = { ...raw, content_hash: contentHash(raw.content) };
      await writeJson(
        resolve(MOCK_DIR, 'zhihu-details', `${summary.work_id}.json`),
        detail,
      );
      totalDetailOk++;
      log(`  ✓ 详情已保存（字数：${detail.content.length}，hash: ${detail.content_hash.slice(0, 8)}…）`);
    } catch (err) {
      totalDetailFail++;
      logError('  获取详情失败，跳过 AI 分析', err);
      continue;
    }

    // AI 背景分析
    log('  开始 AI 背景分析（6 个任务）...');
    const { ok, failed } = await analyzeStory(detail);
    totalAnalysisOk += ok;
    totalAnalysisFail += failed;
    if (failed > 0) {
      log(`  ⚠ 完成 ${ok}/6 个任务，${failed} 个失败`);
    } else {
      log(`  ✓ 全部 6 个背景任务完成`);
    }
  }

  // ── 最终报告 ────────────────────────────────────────────
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log('  初始化报告');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  故事总数：${stories.length}`);
  console.log(`  详情保存：✓ ${totalDetailOk} / ✗ ${totalDetailFail}`);
  console.log(`  AI 分析：✓ ${totalAnalysisOk} / ✗ ${totalAnalysisFail} 个任务`);
  console.log('');
  if (totalDetailFail === 0 && totalAnalysisFail === 0) {
    console.log('  🎉 全部完成！启动演示：');
  } else {
    console.log('  ⚠ 部分任务失败，可重新运行脚本补全。启动演示：');
  }
  console.log('     ZHIHU_USE_FIXTURE=1 npm run dev');
  console.log('═══════════════════════════════════════════════════════');
  console.log('');

  if (totalDetailFail > 0 || totalAnalysisFail > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
