# dsh-log-capture-xg

> [!NOTE] 维护状态
> 本插件为 XG 系列内部工具，**仅供学习参考，不承诺维护**（issue 不保证响应）。
> 最新开发版维护于内网 GitLab XGDSHPlugins；本仓库为源码快照。

DSH 运行时关键日志捕获插件：把 `ctx.logger` 结构化日志（所有插件与服务的日志
通道）按规则过滤后追加写入磁盘文件，另捕获 `agent/error` 与会话生命周期标记。

## 为什么需要

DSH 的 Cordis logger 默认只有**内存 buffer exporter**（保留最近 1000 条），
且没有 stdout exporter：

- `ctx.logger.*` 的日志不会出现在终端，进程重启后 buffer 即丢失
- 排查"上次会话发生了什么"只能靠终端滚动记录或解压 session.jsonl.zstd

本插件注册一个文件 exporter，让关键日志**持续落盘、可按需过滤、按天轮转**。

## 原理

Cordis `LoggerService` 允许通过 `ctx.logger.exporter()` 注册任意数量的
exporter，每次日志调用都会把结构化 `Message`（时间戳 / 级别 / logger 名 /
参数）投递给所有 exporter。本插件在 exporter 回调内：

1. 用 `Logger.format()` 渲染文本行
2. 按规则过滤（级别 / logger 名前缀名单 / 关键词）
3. 追加写入 `<dir>/dsh-capture-<YYYY-MM-DD>.log`

exporter 回调内所有磁盘操作均 try/catch 兜底——写文件失败不影响日志调用方。

## 捕获范围

| 来源 | 说明 |
|------|------|
| `ctx.logger` 全通道 | 所有插件与服务（`log-capture`、`llm-deepseek`、`sandbox-local` 等）的结构化日志 |
| `agent/error` 事件 | 轮次/步骤运行错误（即使未走 logger 也转写） |
| 会话生命周期 | `agent/session-start` / `agent/disposed` 标记行（`== session start: <id> ==`） |

## 配置（cordis.patch.yml）

```yaml
- id: log-capture
  name: 'dsh-log-capture-xg'
  config:
    dir: 'C:\Users\<user>\.dsh\logs'   # 输出目录，默认 ~/.dsh/logs
    level: 'warn'                      # 最低级别（error > warn > info > debug），默认 warn
    include: ['llm-deepseek', 'sandbox-']  # logger name 前缀白名单；空 = 全部
    exclude: []                        # logger name 前缀黑名单（优先于 include）
    keywords: []                       # 消息关键词；任一命中才记录；空 = 不启用
    maxAgeDays: 7                      # 保留天数，超龄文件自动清理
    console: false                     # 同时输出到服务器终端（默认关，避免污染 stdout）
    markSessions: true                 # 写会话标记与 agent/error 转写（默认开）
```

级别语义按严重度 `error > warn > info > debug` 判断，与 cordis 内部
`LoggerLevel` 的数值顺序（ERROR=0 < INFO=1 < WARN=2 < DEBUG=3）无关。

## 典型用法

排查某插件的行为（如 dsh-log-capture-xg 自身的捕获结果）：

```yaml
config:
  level: 'info'
  include: ['log-capture']
```

只关注模型请求失败：

```yaml
config:
  level: 'error'
  keywords: ['failed', 'timeout', 'error']
```

## 部署

1. 构建：`node node_modules/typescript/bin/tsc -p tsconfig.json`（产物 `lib/`）
2. 复制 `lib/` 与 `package.json` 到
   `~/.dsh/profiles/web/node_modules/dsh-log-capture-xg/`
3. `cordis.patch.yml` 添加上述条目
4. 重启 DSH（`pnpm dsh web`）——启动后日志文件出现
   `== log capture started: ... ==` 标记行即生效

## 开发

- 源码 `src/`（逻辑层 `logic.ts` 与插件入口 `index.ts` 分离，可独立单测）
- 单元测试：`node --test tests/logic.spec.mjs`
- 过滤规则与文件轮转逻辑全部在 `logic.ts`，不依赖 cordis
