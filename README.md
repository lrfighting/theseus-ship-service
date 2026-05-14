# theseus-ship-service

盐言互动 · AI Interactive Reading 后端

## 技术栈
- Express + TypeScript
- SSE 流式响应
- AI 分支续写引擎

## 本地开发

```bash
npm install
npm run dev
```

后端运行在 http://localhost:4000

## Render 部署

### 方式一：使用 Blueprint（推荐）

1. 登录 [Render Dashboard](https://dashboard.render.com)
2. 点击 **Blueprints** → **New Blueprint Instance**
3. 选择 `theseus-ship-service` 仓库
4. Render 会自动读取 `render.yaml` 配置创建服务

### 方式二：手动创建 Web Service

1. 登录 [Render Dashboard](https://dashboard.render.com)
2. 点击 **New** → **Web Service**
3. 选择 GitHub 仓库 `lrfighting/theseus-ship-service`
4. 配置：
   - **Name**: `theseus-ship-service`
   - **Runtime**: `Node`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Health Check Path**: `/api/health`
5. 添加环境变量（在 Dashboard → Environment）：
   | Key | Value | 说明 |
   |-----|-------|------|
   | `NODE_ENV` | `production` | 生产环境 |
   | `SERVER_PORT` | `10000` | Render 要求端口 10000 |
   | `AI_PROVIDER` | `kimi` | AI 提供商 |
   | `KIMI_API_KEY` | *你的 Key* | Kimi API Key（必填） |
   | `KIMI_MODEL` | `kimi-k2-0905-preview` | 可选，默认模型 |
   | `ZHIHU_APP_ID` | *你的 ID* | 知乎开放平台 AppID（可选） |
   | `ZHIHU_APP_KEY` | *你的 Key* | 知乎开放平台 AppKey（可选） |
   | `ZHIHU_APP_SECRET` | *你的 Secret* | 知乎开放平台 AppSecret（可选） |
   | `ZHIHU_REDIRECT_URI` | `https://theseus-ship.onrender.com/api/auth/zhihu/callback` | 知乎回调地址 |

### 部署后地址

- API 根地址：`https://theseus-ship-service.onrender.com/api`
- 健康检查：`https://theseus-ship-service.onrender.com/api/health`

> ⚠️ Render 免费实例会在 15 分钟无请求后休眠，首次访问需要等待唤醒（约 30 秒）。
