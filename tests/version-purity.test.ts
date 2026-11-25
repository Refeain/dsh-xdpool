/**
 * T7 / F1 的第二道闸：浏览器包不许因为「更新链改造」把 Node 拖进来。
 *
 * 交接文档的 T1 要求更新链读自己的包名，最自然的写法是在 `update-package.ts` 里
 * `readFileSync` 一次 `package.json`。但 `compareVersions` 原本住在那条链上
 * （`update-check.ts`），而卡片在**浏览器**里用它 —— 于是 `lib/client.js` 里出现了
 * `require("node:fs")`，页面一加载就抛，插件从侧边栏和设置页一起消失，
 * 而且没有任何地方报错（`tests/client-bundle-purity.test.ts` 的模块注释记着同一类事故）。
 *
 * 这个文件只钉一件事：**版本比较必须是纯的**，且浏览器那半边只能从 `version.ts` 取它。
 * 纯行为测试在 `tests/update-check.test.ts`（比较规则）与 `tests/card-shell.test.ts`
 * （POOL_VERSION 与 package.json 同步）里。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const version = readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8')
const updateCheck = readFileSync(new URL('../src/update-check.ts', import.meta.url), 'utf8')

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const versionCode = codeOnly(version)
const updateCheckCode = codeOnly(updateCheck)

describe('version.ts 是纯的', () => {
  it('不 import 任何东西', () => {
    /*
      它被打进浏览器包。哪怕只 import 一个会读文件的小工具，整条链都会跟进来 ——
      这正是本次的故障形态，所以这里用"一个 import 都没有"这种最硬的形式钉住。
    */
    expect(versionCode).not.toMatch(/^\s*import\s/mu)
    expect(versionCode).not.toContain('node:')
  })

  it('compareVersions 定义在这里（不是壳）', () => {
    // 定义搬走后如果只留一个 re-export，浏览器仍要 import 那个壳，等于没搬。
    expect(versionCode).toContain('export function compareVersions(left: string, right: string): number {')
    // 函数体必须在（有 parse 与分叉），不能是一句 return 0
    expect(versionCode).toContain('const parse = (value: string)')
    expect(versionCode).toContain("if (a.pre === '' && b.pre !== '') return 1")
  })
})

describe('两个浏览器文件从 version.ts 取版本比较', () => {
  for (const file of ['shell.tsx', 'UpdatePanel.tsx']) {
    it(`${file} 不再从 update-check.ts 取 compareVersions`, () => {
      const source = readFileSync(new URL(`../src/client/${file}`, import.meta.url), 'utf8')
      expect(source).toContain("import { compareVersions } from '../version.ts'")
      expect(source).not.toContain("import { compareVersions } from '../update-check.ts'")
    })
  }
})

describe('update-check.ts 仍然对外提供 compareVersions', () => {
  it('用 re-export 而不是第二份实现', () => {
    /*
      服务端调用方与老测试都从 update-check 里取它。保留 re-export 是为了不制造
      "两份定义"——那才是真正会漂的形态。这里同时断言"没有第二份函数体"。
    */
    expect(updateCheckCode).toContain('export { compareVersions }')
    expect(updateCheckCode).not.toContain('const parse = (value: string)')
  })
})
