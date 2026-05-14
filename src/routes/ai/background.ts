/**
 * 背景任务路由：
 *   POST /api/ai/background/:task_type   单个任务
 *   POST /api/ai/background/all          一次性触发全部，按完成顺序流式回（SSE）
 *
 * 入参统一为 BackgroundTaskInputBase。
 */

import { Router } from 'express';
import { badRequest } from '../../utils/errors';
import { createLogger } from '../../utils/logger';
import {
  getOrCreateCharacters,
  getOrCreateKeyNodes,
  getOrCreateObjects,
  getOrCreateRelations,
  getOrCreateSummary,
  getOrCreateWorld,
} from '../../services/orchestrator';
import { createSseSender } from '../../utils/sse';
import type {
  BackgroundTaskInputBase,
  BackgroundTaskResponse,
  BackgroundTaskType,
  StoryArchiveBundle,
} from '@shared/types/ai';

const log = createLogger('route.ai.background');

export const backgroundRouter = Router();

type Runner = (
  input: BackgroundTaskInputBase,
) => Promise<{ data: unknown; source: string; meta: Record<string, unknown> }>;

const runners: Record<BackgroundTaskType, Runner> = {
  summary: getOrCreateSummary as unknown as Runner,
  world: getOrCreateWorld as unknown as Runner,
  characters: getOrCreateCharacters as unknown as Runner,
  relations: getOrCreateRelations as unknown as Runner,
  objects: getOrCreateObjects as unknown as Runner,
  key_nodes: getOrCreateKeyNodes as unknown as Runner,
};

function validateInput(body: unknown): BackgroundTaskInputBase {
  const b = body as Partial<BackgroundTaskInputBase> | undefined;
  if (!b || !b.work_id || !b.content_hash || !b.story) {
    throw badRequest('Invalid background task input', { received: b });
  }
  return b as BackgroundTaskInputBase;
}

backgroundRouter.post('/:taskType', async (req, res, next) => {
  try {
    const taskType = req.params.taskType as BackgroundTaskType;
    const runner = runners[taskType];
    if (!runner) throw badRequest(`Unknown background task: ${taskType}`);

    const input = validateInput(req.body);
    const result = await runner(input);

    const payload: BackgroundTaskResponse<typeof taskType> = {
      task_type: taskType,
      data: result.data as never,
      meta: {
        cache_key: String(result.meta.cache_key ?? ''),
        source: result.source as never,
        model: String(result.meta.model ?? ''),
        prompt_version: String(result.meta.prompt_version ?? ''),
        template_key: result.meta.template_key as never,
        generated_at: Number(result.meta.generated_at ?? Date.now()),
      },
    };
    res.json(payload);
  } catch (err) {
    next(err);
  }
});

/**
 * 全套背景任务一次性触发（前端 useStoryBackground 调用）。
 * 走 SSE：每个任务完成发一次 `event: ready`，全部完成发 `event: done`。
 */
backgroundRouter.post('/all/stream', async (req, res) => {
  const sender = createSseSender<StoryArchiveBundle>(res);
  let input: BackgroundTaskInputBase;
  try {
    input = validateInput(req.body);
  } catch (err) {
    sender.error({
      code: 'BAD_REQUEST',
      message: (err as Error).message,
      retryable: false,
    });
    sender.done();
    return;
  }

  const bundle: StoryArchiveBundle = {
    work_id: input.work_id,
    content_hash: input.content_hash,
    template_key: 'prompt_template_general',
    readiness: {
      summary: 'pending',
      world: 'pending',
      characters: 'pending',
      relations: 'pending',
      objects: 'pending',
      key_nodes: 'pending',
    },
  };

  const taskList: BackgroundTaskType[] = [
    'summary',
    'world',
    'characters',
    'objects',
    'key_nodes',
    'relations', // relations depends on characters but runners de-dup
  ];

  sender.status({
    status: 'queued',
    upstream_ready: 0,
    upstream_total: taskList.length,
  });

  let readyCount = 0;
  await Promise.all(
    taskList.map(async (taskType) => {
      try {
        const result = await runners[taskType](input);
        switch (taskType) {
          case 'summary':
            bundle.summary = result.data as never;
            break;
          case 'world':
            bundle.world = result.data as never;
            bundle.template_key = (result.meta.template_key as never) ?? bundle.template_key;
            break;
          case 'characters':
            bundle.characters = result.data as never;
            break;
          case 'relations':
            bundle.relations = result.data as never;
            break;
          case 'objects':
            bundle.objects = result.data as never;
            break;
          case 'key_nodes':
            bundle.key_nodes = result.data as never;
            break;
        }
        bundle.readiness[taskType] = 'ready';
        readyCount += 1;
        sender.status({
          status: 'generating',
          task_id: taskType,
        });
        // 复用 delta 通道携带就绪进度：text 字段塞 JSON
        sender.delta({
          text: JSON.stringify({
            kind: 'background_ready',
            task_type: taskType,
            ready: readyCount,
            total: taskList.length,
            data: result.data,
            meta: result.meta,
          }),
        });
      } catch (err) {
        bundle.readiness[taskType] = 'failed';
        log.warn(`background task ${taskType} failed`, err);
        sender.delta({
          text: JSON.stringify({
            kind: 'background_failed',
            task_type: taskType,
            error: (err as Error).message,
          }),
        });
      }
    }),
  );

  sender.final(bundle);
  sender.done();
});
