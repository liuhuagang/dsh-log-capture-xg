/**
 * dsh-log-capture-xg：DSH 运行时关键日志捕获插件。
 *
 * 原理：Cordis LoggerService 内置一个内存 buffer exporter（保留最近 1000 条，
 * 进程重启即丢），且 DSH 默认没有 stdout exporter —— ctx.logger 的日志不会
 * 出现在终端。本插件通过 `ctx.logger.exporter()` 注册一个文件 exporter，
 * 把结构化日志（Message：时间戳/级别/logger 名/参数）按规则过滤后追加写入
 * 磁盘文件，实现"捕获我们想要的关键日志"。
 *
 * 捕获范围：
 *   1. ctx.logger 全通道日志（所有插件与服务的结构化日志），按规则过滤
 *   2. agent/error 事件（轮次/步骤运行错误，即使未走 logger 也转写）
 *   3. 会话生命周期标记（agent/session-start / agent/disposed），便于检索
 *
 * 过滤规则（Config）：
 *   - level：最低级别（error > warn > info > debug），默认 warn
 *   - include / exclude：logger name 前缀名单（如 'project-profile'、'llm-'）
 *   - keywords：消息文本关键词（任一命中才记录）
 *
 * 落盘：<dir>/dsh-capture-<YYYY-MM-DD>.log 按天轮转，超龄文件自动清理。
 * exporter 回调内所有磁盘操作均 try/catch 兜底 —— 写文件失败不得影响
 * 日志调用方（Logger._method 对 exporter 异常无隔离）。
 */

import { Logger, type Context, type Exporter, type Message } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  appendLines,
  cleanupOldLogs,
  dayKey,
  fileNameFor,
  normalizeRule,
  passesFilter,
  renderLine,
  type LogLevel,
} from './logic.js'

export const name = 'dsh-log-capture-xg'

/** 插件配置（cordis.patch.yml 中 config 字段） */
export interface Config {
  /** 总开关；false 时插件不注册任何捕获，默认 true */
  enabled?: boolean
  /** 捕获日志输出目录，默认 ~/.dsh/logs */
  dir?: string
  /** 最低级别（含）：记录该级别及更严重的日志，默认 'warn' */
  level?: LogLevel
  /** logger name 前缀白名单；空数组 = 全部通过 */
  include?: string[]
  /** logger name 前缀黑名单；命中即排除（优先于 include） */
  exclude?: string[]
  /** 消息文本关键词；任一命中才记录；空数组 = 不按关键词过滤 */
  keywords?: string[]
  /** 保留天数：清理超过 N 天的捕获文件，默认 7 */
  maxAgeDays?: number
  /** 每条捕获同时 console.log 到服务器终端（默认 false，避免污染 stdout） */
  console?: boolean
  /** 写会话开始/结束标记行与 agent/error 转写（默认 true） */
  markSessions?: boolean
}

export function apply(ctx: Context, config: Config): void {
  if (config.enabled === false) return

  const dir = config.dir ?? join(homedir(), '.dsh', 'logs')
  const rule = normalizeRule({
    minLevel: config.level,
    include: config.include,
    exclude: config.exclude,
    keywords: config.keywords,
  })
  const maxAgeDays = config.maxAgeDays ?? 7
  const toConsole = config.console === true
  const markSessions = config.markSessions !== false

  /** 内部状态：按天轮转 + 每天一次超龄清理 */
  let currentDay = dayKey(Date.now())
  let cleanedDay = ''

  /** 统一写入入口：渲染 → 落盘（→ 可选终端）；任何异常只警告不抛出 */
  function write(ts: number, type: string, loggerName: string, text: string): void {
    try {
      const day = dayKey(ts)
      if (day !== currentDay) {
        currentDay = day
        if (cleanedDay !== day) {
          cleanedDay = day
          cleanupOldLogs(dir, maxAgeDays, ts)
        }
      }
      const line = renderLine(ts, type, loggerName, text)
      appendLines(fileNameFor(dir, currentDay), [line])
      if (toConsole) console.log(`[log-capture] ${line}`)
    } catch (error) {
      console.warn(`[log-capture] write failed: ${String(error)}`)
    }
  }

  /** 无时间戳语义的内部行（会话标记、启动标记）：type=info、name=capture */
  function mark(text: string): void {
    write(Date.now(), 'info', 'capture', text)
  }

  // 1. logger exporter：全通道结构化日志，回调内按规则过滤。
  //    不设 exporter.levels —— cordis 的 level 数值（ERROR=0 < INFO=1 < WARN=2
  //    < DEBUG=3）不是严重度顺序，语义易混；统一在回调里按 type 判断。
  ctx.logger.exporter({
    export: (message: Message) => {
      // Logger.format 需要 Exporter 形态（只用到 colors/formatters/maxLength）
      const text = Logger.format({ colors: false, export: () => {} }, message)
      if (!passesFilter(message.name, message.type, text, rule)) return
      write(message.ts, message.type, message.name, text)
    },
  } satisfies Exporter)

  // 启动标记（含配置摘要），确认插件生效与当前过滤规则
  mark(`== log capture started: dir=${dir} level=${rule.minLevel} include=[${rule.include.join(',')}] exclude=[${rule.exclude.join(',')}] keywords=[${rule.keywords.join(',')}] maxAgeDays=${maxAgeDays} ==`)

  if (!markSessions) return

  // 2. 会话生命周期标记（全局 ctx 注册可收到 agent/* 事件：scope filter 对
  //    无 scope 标签的 ctx 放行）。监听器异常不得 veto 发布，整体兜底。
  ctx.on('agent/session-start', ({ agent, source }: { agent: Agent; source: string }) => {
    try {
      mark(`== session start: ${String(agent.id)} (source=${source}) ==`)
    } catch (error) {
      console.warn(`[log-capture] session-start mark failed: ${String(error)}`)
    }
  })

  ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
    try {
      mark(`== session end: ${String(agent.id)} ==`)
    } catch (error) {
      console.warn(`[log-capture] session-end mark failed: ${String(error)}`)
    }
  })

  // 3. agent/error 转写：轮次/步骤运行错误是最高价值的关键日志。
  ctx.on('agent/error', ({ agent, turn, step, error }: { agent: Agent; turn: number; step: number; error: unknown }) => {
    try {
      write(Date.now(), 'error', 'agent', `agent ${String(agent.id)} error at turn=${turn} step=${step}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    } catch (writeError) {
      console.warn(`[log-capture] agent/error write failed: ${String(writeError)}`)
    }
  })

  // 4. 会话生命周期标记与错误转写结束
}
