import { Router } from 'express';
import { fetchStoryList, fetchStoryDetail } from '../services/zhihu';
import { notFound } from '../utils/errors';

export const zhihuRouter = Router();

zhihuRouter.get('/list', async (_req, res, next) => {
  try {
    const data = await fetchStoryList();
    res.json({ data, source: 'live' });
  } catch (err) {
    next(err);
  }
});

zhihuRouter.get('/detail/:workId', async (req, res, next) => {
  try {
    const detail = await fetchStoryDetail(req.params.workId);
    if (!detail) throw notFound('story');
    res.json({ data: detail, source: 'live' });
  } catch (err) {
    next(err);
  }
});
