import { Router } from 'express';
import { zhihuRouter } from './zhihu';
import { authRouter } from './auth';
import { backgroundRouter } from './ai/background';
import { streamRouter } from './ai/stream';

export const apiRouter = Router();

apiRouter.get('/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

apiRouter.use('/zhihu', zhihuRouter);
apiRouter.use('/auth', authRouter);
apiRouter.use('/ai/background', backgroundRouter);
apiRouter.use('/ai/stream', streamRouter);

