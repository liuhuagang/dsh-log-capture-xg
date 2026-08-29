#!/usr/bin/env node
/**
 * dsh-log-capture-xg 构建脚本（跨平台 Node，无外部依赖）。
 *
 * 步骤：
 *   0. 补齐 node_modules junction（指向 DSH checkout，仅供 tsc 类型检查；
 *      运行时的真实依赖由 DSH profile 的 node_modules 提供）
 *   1. tsc 编译宿主 src → lib/（ESM，宿主端 + 类型声明）
 *   2. 验证：宿主 import（name）
 *   3. 单元测试（node --test）
 *
 * 用法：node scripts/build.mjs
 * 环境变量：DSH_CHECKOUT 指定 DSH checkout 根目录（默认 D:/deepseek-harness）
 */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const checkout = process.env.DSH_CHECKOUT ?? 'D:/deepseek-harness'
const nm = join(root, 'node_modules')
const scoped = join(nm, '@deepseek-ai')

function ensureJunction(link, target) {
  if (!existsSync(target)) throw new Error(`junction 目标缺失: ${target}`)
  const st = lstatSync(link, { throwIfNoEntry: false })
  if (st !== undefined) return // 已存在（junction 或真实目录），不覆盖
  mkdirSync(join(link, '..'), { recursive: true })
  symlinkSync(target, link, 'junction')
  console.log(`junction: ${link} -> ${target}`)
}

// 0. junctions（类型检查用）
ensureJunction(join(scoped, 'cordis'), join(checkout, 'vendor', 'cordis'))
ensureJunction(join(scoped, 'dsh-agent'), join(checkout, 'packages', 'core', 'agent'))
ensureJunction(join(nm, 'typescript'), join(checkout, 'node_modules', 'typescript'))
ensureJunction(join(nm, '@types', 'node'), join(checkout, 'node_modules', '@types', 'node'))

const node = process.execPath
const tsc = join(checkout, 'node_modules', 'typescript', 'bin', 'tsc')

function run(step, cmd, args) {
  console.log(`\n=== ${step} ===`)
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })
}

// 1. 宿主端 tsc
run('1/3 host: tsc', node, [tsc, '-p', 'tsconfig.json'])

// 2. 验证
console.log('\n=== 2/3 verify ===')
const hostCheck = execFileSync(
  node,
  ['-e', `import('./lib/index.js').then(m => { console.log('host ok: name=' + m.name); })`],
  { cwd: root, encoding: 'utf8' },
)
console.log(hostCheck.trim())
if (!existsSync(join(root, 'lib', 'types', 'index.d.ts'))) {
  throw new Error('lib/types/index.d.ts missing')
}

// 3. 单元测试
run('3/3 tests: node --test', node, ['--test', 'tests/logic.spec.mjs'])

console.log('\nbuild 完成：lib/ 就绪（宿主 ESM + 类型声明）')
