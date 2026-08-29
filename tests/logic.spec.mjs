/**
 * dsh-log-capture-xg 纯逻辑层单元测试（Node 内置 test runner）。
 * 运行：node --test tests/
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendLines,
  cleanupOldLogs,
  dayKey,
  fileNameFor,
  normalizeRule,
  parseLogDate,
  passesFilter,
  renderLine,
} from '../lib/logic.js'

// ---------- normalizeRule ----------

test('normalizeRule 填充默认值', () => {
  const rule = normalizeRule({})
  assert.equal(rule.minLevel, 'warn')
  assert.deepEqual(rule.include, [])
  assert.deepEqual(rule.exclude, [])
  assert.deepEqual(rule.keywords, [])
})

test('normalizeRule 保留显式值', () => {
  const rule = normalizeRule({ minLevel: 'debug', include: ['a'], exclude: ['b'], keywords: ['k'] })
  assert.equal(rule.minLevel, 'debug')
  assert.deepEqual(rule.include, ['a'])
})

// ---------- passesFilter：级别 ----------

test('minLevel=warn 时 error/warn 通过，info/debug 丢弃', () => {
  const rule = normalizeRule({ minLevel: 'warn' })
  assert.equal(passesFilter('any', 'error', 'text', rule), true)
  assert.equal(passesFilter('any', 'warn', 'text', rule), true)
  assert.equal(passesFilter('any', 'info', 'text', rule), false)
  assert.equal(passesFilter('any', 'debug', 'text', rule), false)
})

test('minLevel=debug 时全部通过', () => {
  const rule = normalizeRule({ minLevel: 'debug' })
  for (const type of ['error', 'warn', 'info', 'debug']) {
    assert.equal(passesFilter('any', type, 'text', rule), true, type)
  }
})

test('minLevel=error 时只收 error', () => {
  const rule = normalizeRule({ minLevel: 'error' })
  assert.equal(passesFilter('any', 'error', 'text', rule), true)
  assert.equal(passesFilter('any', 'warn', 'text', rule), false)
})

test('未知级别类型防御性丢弃', () => {
  assert.equal(passesFilter('any', 'verbose', 'text', normalizeRule({})), false)
})

// ---------- passesFilter：logger 名单 ----------

test('include 前缀白名单：命中才收', () => {
  const rule = normalizeRule({ include: ['project-profile', 'llm-'] })
  assert.equal(passesFilter('project-profile', 'warn', 'text', rule), true)
  assert.equal(passesFilter('llm-deepseek', 'warn', 'text', rule), true)
  assert.equal(passesFilter('sandbox-local', 'warn', 'text', rule), false)
})

test('include 空数组 = 全部通过', () => {
  assert.equal(passesFilter('whatever', 'warn', 'text', normalizeRule({})), true)
})

test('exclude 前缀黑名单优先于 include', () => {
  const rule = normalizeRule({ include: ['llm-'], exclude: ['llm-deepseek'] })
  assert.equal(passesFilter('llm-retry', 'warn', 'text', rule), true)
  assert.equal(passesFilter('llm-deepseek', 'warn', 'text', rule), false)
})

// ---------- passesFilter：关键词 ----------

test('keywords 任一命中才记录', () => {
  const rule = normalizeRule({ keywords: ['failed', 'timeout'] })
  assert.equal(passesFilter('a', 'error', 'request failed: 500', rule), true)
  assert.equal(passesFilter('a', 'error', 'connection timeout', rule), true)
  assert.equal(passesFilter('a', 'error', 'all good', rule), false)
})

test('keywords 与级别规则叠加', () => {
  const rule = normalizeRule({ minLevel: 'error', keywords: ['failed'] })
  assert.equal(passesFilter('a', 'error', 'failed', rule), true)
  assert.equal(passesFilter('a', 'warn', 'failed', rule), false) // 级别不够
  assert.equal(passesFilter('a', 'error', 'ok', rule), false) // 关键词不中
})

// ---------- renderLine / dayKey / fileNameFor ----------

test('renderLine 输出 ISO 时间戳 + 级别 + name + 文本', () => {
  const line = renderLine(0, 'warn', 'project-profile', 'hello')
  assert.match(line, /^1970-01-01T00:00:00\.000Z \[warn\] project-profile: hello$/)
})

test('dayKey 返回本地时区 YYYY-MM-DD', () => {
  const key = dayKey(Date.now())
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/)
})

test('fileNameFor 拼接目录与文件名', () => {
  assert.equal(fileNameFor('D:\\logs', '2026-01-02'), join('D:\\logs', 'dsh-capture-2026-01-02.log'))
})

// ---------- parseLogDate ----------

test('parseLogDate 解析合法捕获文件名', () => {
  const date = parseLogDate('dsh-capture-2026-05-01.log')
  assert.ok(date)
  assert.equal(date.getFullYear(), 2026)
  assert.equal(date.getMonth(), 4) // 0-based
  assert.equal(date.getDate(), 1)
})

test('parseLogDate 拒绝非法与非捕获文件名', () => {
  assert.equal(parseLogDate('dsh-capture-2026-13-01.log'), null) // 13 月
  assert.equal(parseLogDate('other.log'), null)
  assert.equal(parseLogDate('dsh-capture-2026-05-01.txt'), null)
})

// ---------- appendLines / cleanupOldLogs（临时目录） ----------

test('appendLines 创建目录并追加多行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-capture-test-'))
  try {
    const file = join(dir, 'sub', 'dsh-capture-2026-05-01.log')
    appendLines(file, ['line1', 'line2'])
    const content = readFileSync(file, 'utf8')
    assert.equal(content, 'line1\nline2\n')
    // 再次追加不覆盖
    appendLines(file, ['line3'])
    assert.equal(readFileSync(file, 'utf8'), 'line1\nline2\nline3\n')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('appendLines 空行数组不写文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-capture-test-'))
  try {
    appendLines(join(dir, 'dsh-capture-2026-05-01.log'), [])
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanupOldLogs 只删超龄捕获文件，保留目录内其他文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-capture-test-'))
  try {
    const now = Date.now()
    const dayMs = 24 * 60 * 60 * 1000
    // 3 天前（超龄）、今天（保留）、非捕获文件（不碰）
    writeFileSync(join(dir, 'dsh-capture-2020-01-01.log'), 'old')
    writeFileSync(join(dir, `dsh-capture-${dayKey(now)}.log`), 'today')
    writeFileSync(join(dir, 'notes.txt'), 'keep me')

    const removed = cleanupOldLogs(dir, 1, now)
    assert.equal(removed, 1)
    const remaining = readdirSync(dir).sort()
    assert.deepEqual(remaining, [`dsh-capture-${dayKey(now)}.log`, 'notes.txt'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanupOldLogs 目录不存在时安全返回 0', () => {
  assert.equal(cleanupOldLogs(join(tmpdir(), 'no-such-dir-xyz'), 7, Date.now()), 0)
})
