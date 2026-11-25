/**
 * 窄屏横滑条不能把分组标题一起扁平化。
 *
 * 这一条来自一次真机图形证据：390 宽度下截图里「已登录」「未登录」被压成竖排单字
 * （"已"在最上一行、"登"在下一行），而设计稿的 `@media (max-width:640px)` 明确写着
 * `.list-group{display:none}`。量 computed style 才看清根因：
 *
 *   `.app[data-w="phone"] .list-scroll>div{display:contents}`  权重 (0,3,1)
 *   `.app[data-w="phone"] .list-group{display:none}`           权重 (0,3,0)
 *
 * 分组标题本身就是 `div`，被 `>div` 一起命中了 —— 它没被隐藏，反而变成 `display:contents`
 * 把里面的文字拆成一个个 flex 子项，在横滑条里各占一格，看起来就像竖排。
 *
 * 所以这里守两件事：
 *   1. 扁平化规则必须排除 `.list-group`；
 *   2. `display:none` 那条规则还在（别用「删掉隐藏、只修扁平化」蒙过去 —— 那会让标题
 *      重新出现，而设计稿的窄屏就是不显示它）。
 *
 * 为什么用文本断言而不是渲染断言：仓库里没有 jsdom，CSS 级联也不在 vitest 能算的范围里
 * （宽度档由 ResizeObserver 写到 data-w 上，要真实布局才有）。真正的像素证据是
 * `_layout-harness` 的 390/1280 实测，这里只守"下一次别把它改回去"。
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../src/client/responsive-css.ts', import.meta.url), 'utf8')

/** 去掉块注释，避免「注释里写了 `>div`」被当成规则命中。 */
function rulesOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//gu, '')
}

const css = rulesOnly(source)

describe('窄屏渠道横滑条', () => {
  it('两个窄档的扁平化规则都排除分组标题', () => {
    for (const width of ['narrow', 'phone']) {
      expect(css).toContain(`.app[data-w="${width}"] .list-scroll>div:not(.list-group){display:contents}`)
    }
  })

  it('不再有裸的 .list-scroll>div 规则（那会连 .list-group 一起命中）', () => {
    /* 允许 `>div:not(.list-group)`，但不允许后面直接跟 `{` */
    expect(css).not.toMatch(/\.list-scroll>div\s*\{/u)
  })

  it('分组标题在窄档仍然是隐藏的', () => {
    expect(css).toMatch(/\.app\[data-w="narrow"\] \.list-group\{display:none\}/u)
    expect(css).toMatch(/\.app\[data-w="phone"\] \.list-group\{display:none/u)
  })

  it('只有 .app 作用域内的选择器（不漏到宿主）', () => {
    /* 每个非空行要么是注释、要么以 .app / .app-wide 开头，要么是块内声明的延续 */
    const offenders = css
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '')
      .filter(line => line.startsWith('.') && !line.startsWith('.app'))
    expect(offenders).toEqual([])
  })
})
