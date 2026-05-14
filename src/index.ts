import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { config } from './config';
import { createLogger } from './utils/logger';
import { apiRouter } from './routes';
import { AppError } from './utils/errors';
import { getAiProvider } from './services/ai';

const log = createLogger('app');

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '4mb' }));

app.use('/api', apiRouter);

// 生产环境：服务前端静态文件（需先将前端 build 产物放入 backend/dist/）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distPath = path.resolve(__dirname, '../dist');
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.use((_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
}

// 兜底错误处理
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.toPayload() });
    return;
  }
  log.error('Unhandled error', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: (err as Error).message ?? 'internal error',
      retryable: false,
    },
  });
});

app.listen(config.port, () => {
  getAiProvider(); // 提前打印 provider 选择信息
  log.info(`Server listening on http://localhost:${config.port}`);
  log.info(`AI cache dir: ${config.cache.dir}`);
});
