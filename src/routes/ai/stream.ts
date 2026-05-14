/**
 * 流式 AI 路由（SSE）：
 *   POST /api/ai/stream/branch-continuation
 *
 * 行为：
 *  1. 立即发 status: queued
 *  2. 等背景全部就绪（onProgress 推 status）
 *  3. 流式调用 provider，每收到一段正文增量发 delta
 *  4. 完成后发 final，再发 done
 *  5. 客户端断开 → AbortController 终止 provider 调用
 */

import { Router } from 'express';
import { createSseSender } from '../../utils/sse';
import { badRequest } from '../../utils/errors';
import { createLogger } from '../../utils/logger';
import {
  waitForBackground,
  withBranchSerial,
} from '../../services/orchestrator';
import { runBranchContinuation } from '../../services/ai/branchContinuationRunner';
import type {
  BackgroundTaskInputBase,
  BranchContinuationInput,
  BranchContinuationResult,
} from '@shared/types/ai';
import type { Branch } from '@shared/types/story';

const log = createLogger('route.ai.stream');

export const streamRouter = Router();

interface BaseStreamBody {
  story: BackgroundTaskInputBase['story'] & { work_id: string; content_hash: string };
}

function extractBgInput(body: BaseStreamBody): BackgroundTaskInputBase {
  if (!body.story?.work_id || !body.story?.content_hash) {
    throw badRequest('story.work_id and story.content_hash required');
  }
  return {
    work_id: body.story.work_id,
    content_hash: body.story.content_hash,
    story: {
      chapter_name: body.story.chapter_name,
      author_name: body.story.author_name,
      labels: body.story.labels ?? [],
      introduction: body.story.introduction,
      content: body.story.content,
    },
  };
}

// ───────────────────────────────────────────────────────
// 分支续写
// ───────────────────────────────────────────────────────

streamRouter.post('/branch-continuation', async (req, res) => {
  const sender = createSseSender<BranchContinuationResult>(res);
  const body = req.body as BranchContinuationInput & BaseStreamBody;

  if (!body?.branch_id || !body?.choice_text || !body?.branch_type) {
    sender.error({
      code: 'BAD_REQUEST',
      message: 'branch_id / choice_text / branch_type are required',
      retryable: false,
    });
    sender.done();
    return;
  }

  let bgInput: BackgroundTaskInputBase;
  try {
    bgInput = extractBgInput(body);
  } catch (err) {
    sender.error({
      code: 'BAD_REQUEST',
      message: (err as Error).message,
      retryable: false,
    });
    sender.done();
    return;
  }

  const aborter = new AbortController();
  sender.onClose(() => aborter.abort());

  try {
    sender.status({ status: 'queued', upstream_ready: 0, upstream_total: 5 });

    const bg = await waitForBackground(bgInput, (p) => {
      sender.status({
        status: 'queued',
        upstream_ready: p.ready,
        upstream_total: p.total,
      });
    });

    if (sender.closed()) return;

    sender.status({ status: 'generating', task_id: body.branch_id });

    const result = await withBranchSerial(body.work_id, async () => {
      const lineageBranches: Branch[] = body.lineage_branches ?? [];
      const sourceNode = body.source_node ?? null;

      return runBranchContinuation(
        body,
        {
          summary: bg.summary,
          world: bg.world,
          characters: bg.characters,
          relations: bg.relations,
          objects: bg.objects,
          source_node: sourceNode ?? undefined,
          lineage_branches: lineageBranches,
          story: bgInput.story,
        },
        {
          onContentDelta: (delta) => sender.delta({ text: delta }),
        },
      );
    });

    if (sender.closed()) return;
    sender.final(result);
    sender.done();
  } catch (err) {
    log.warn('branch continuation failed', err);
    const code = (err as { code?: string }).code ?? 'AI_FAILED';
    const message = (err as Error).message || '生成失败，请稍后重试';
    const retryable = code !== 'BAD_REQUEST' && code !== 'CANCELLED';
    sender.error({ code, message, retryable });
    sender.done();
  }
});
