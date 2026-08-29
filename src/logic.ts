/**
 * dsh-log-capture-xg 纯逻辑层：规则匹配、日志行渲染、按天轮转文件写入。
 *
 * 本文件只依赖 Node 内置模块，不依赖 cordis，所有函数可独立单元测试。
 * 级别语义与 cordis 的 LoggerLevel 数值（ERROR=0 < INFO=1 < WARN=2 < DEBUG=3）
 * 无关，避免数值顺序混淆：统一按严重度 error > warn > info > debug 判断。
 */

import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 日志级别（与 cordis LoggerType 一致） */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

/** 严重度顺序：数值越小越严重（error < warn < info < debug） */
export const LEVEL_ORDER: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

/** 捕获过滤规则（与插件 Config 中同名字段一致） */
export interface FilterRule {
  /** 最低级别（含）：记录该级别及更严重的日志，默认 'warn' */
  minLevel?: LogLevel
  /** logger name 前缀白名单；空数组 = 全部通过 */
  include?: string[]
  /** logger name 前缀黑名单；命中即排除（优先于 include） */
  exclude?: string[]
  /** 消息文本关键词；任一命中才记录；空数组 = 不按关键词过滤 */
  keywords?: string[]
}

/** 归一化规则：填充默认值，返回不可变副本 */
export function normalizeRule(rule: FilterRule): Required<FilterRule> {
  return {
    minLevel: rule.minLevel ?? 'warn',
    include: rule.include ?? [],
    exclude: rule.exclude ?? [],
    keywords: rule.keywords ?? [],
  }
}

/**
 * 判断一条日志是否通过过滤规则。
 *
 * @param name  logger 名（message.name）
 * @param type  级别（message.type：error/warn/info/debug）
 * @param text  渲染后的消息文本
 * @param rule  过滤规则（未归一化亦可）
 */
export function passesFilter(name: string, type: string, text: string, rule: FilterRule): boolean {
  const r = normalizeRule(rule)
  const level = LEVEL_ORDER[type as LogLevel]
  // 未知级别类型：防御性丢弃
  if (level === undefined) return false
  // 级别低于最低要求 → 丢弃（minLevel 数值越小越严重）
  if (level > LEVEL_ORDER[r.minLevel]) return false
  // logger 名前缀名单
  if (r.include.length > 0 && !r.include.some((prefix) => name.startsWith(prefix))) return false
  if (r.exclude.some((prefix) => name.startsWith(prefix))) return false
  // 关键词（任一命中才记录）
  if (r.keywords.length > 0 && !r.keywords.some((keyword) => text.includes(keyword))) return false
  return true
}

/** 渲染一条捕获日志行：ISO 时间戳 + 级别 + logger 名 + 文本 */
export function renderLine(ts: number, type: string, name: string, text: string): string {
  return `${new Date(ts).toISOString()} [${type}] ${name}: ${text}`
}

/** 本地时区日期键 YYYY-MM-DD（按天轮转文件名用） */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 捕获文件名：<dir>/dsh-capture-<YYYY-MM-DD>.log */
export function fileNameFor(dir: string, day: string): string {
  return join(dir, `dsh-capture-${day}.log`)
}

/** 追加多行到文件（自动创建父目录，UTF-8，每行结尾补 \n） */
export function appendLines(file: string, lines: string[]): void {
  if (lines.length === 0) return
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, lines.map((line) => line + '\n').join(''), 'utf8')
}

/** 从捕获文件名解析日期（dsh-capture-YYYY-MM-DD.log → Date），非捕获文件返回 null */
export function parseLogDate(fileName: string): Date | null {
  const match = /^dsh-capture-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(fileName)
  if (!match) return null
  const [, y, m, d] = match
  const date = new Date(Number(y), Number(m) - 1, Number(d))
  // 非法日期（如 13 月）回退为 null
  if (date.getFullYear() !== Number(y) || date.getMonth() !== Number(m) - 1 || date.getDate() !== Number(d)) return null
  return date
}

/** 删除超过 maxAgeDays 天的捕获文件；返回删除数量。只处理 dsh-capture-*.log，不触碰其他文件。 */
export function cleanupOldLogs(dir: string, maxAgeDays: number, now: number): number {
  const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000
  let removed = 0
  let entries: { name: string; isFile: boolean }[] = []
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
    }))
  } catch {
    return 0 // 目录不存在或不可读：无事可做
  }
  for (const entry of entries) {
    if (!entry.isFile) continue
    const date = parseLogDate(entry.name)
    if (date && date.getTime() < cutoff) {
      try {
        rmSync(join(dir, entry.name), { force: true })
        removed += 1
      } catch {
        // 忽略单个文件删除失败
      }
    }
  }
  return removed
}
