/**
 * T5 的接线守卫：清除首选要能点，已移除的账号要能找到并恢复。
 *
 * 两件事都是"数据在后端、样式在本地、界面却没读"的类型 —— 纯函数测试全绿，
 * 用户照样点不到（F6）。所以这里查的是真实的渲染分支与判定条件。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const section = readFileSync(new URL('../src/client/ChannelPoolSection.tsx', import.meta.url), 'utf8')
const poolCard = readFileSync(new URL('../src/client/PoolCard.tsx', import.meta.url), 'utf8')

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const sectionCode = codeOnly(section)
const poolCardCode = codeOnly(poolCard)

describe('首选按钮的两个分支都能点（F6 前半）', () => {
  it('禁用条件里不再有 account.preferred', () => {
    /*
      3.2.0 写的是 `disabled={busy || account.preferred}`。首选着的账号上按钮恰好
      被禁用，于是 `onPrefer(account.preferred ? null : account.id)` 的 null 分支
      永远走不到 —— "一个都不首选"这个真实状态在界面上不存在。
    */
    const preferBlock = sectionCode.slice(
      sectionCode.indexOf("aria-pressed={account.preferred === true}"),
      sectionCode.indexOf("aria-pressed={account.preferred === true}") + 900,
    )
    expect(preferBlock).toContain('disabled={busy}')
    expect(preferBlock).not.toContain('busy || account.preferred')
    // 点了之后仍然按当前状态决定是设还是清
    expect(preferBlock).toContain('lane.onPrefer(account.preferred ? null : account.id)')
  })

  it('首选着的按钮有可辨认的外观与取消提示', () => {
    expect(sectionCode).toContain("className={account.preferred ? 'tiny is-on' : 'tiny'}")
    expect(sectionCode).toContain("t?.('row.accountPreferClearHint')")
  })
})

describe('已移除的账号有恢复入口（F6 后半）', () => {
  it('lane 带出 ignored 与 onRestore', () => {
    expect(sectionCode).toContain('readonly ignored?: readonly IgnoredEntry[] | undefined')
    expect(sectionCode).toContain('readonly onRestore?: ((entry: IgnoredEntry) => void) | undefined')
  })

  it('从 status.ignored 真的取出清单（3.2.0 从未读过这个字段）', () => {
    expect(poolCardCode).toContain('ignoredFrom(statusOf(region))')
    expect(poolCardCode).toContain('ignored: ignoredOf(region)')
  })

  it('清单非空时才画这一块', () => {
    // 一个空的「已移出的账号」会让读者以为移出过什么。
    expect(sectionCode).toContain('lane.ignored.length === 0 ? null : (')
  })

  it('每行有恢复按钮，且调用 onRestore', () => {
    expect(sectionCode).toContain("t?.('row.ignoredRestore')")
    expect(sectionCode).toContain('lane.onRestore?.(entry)')
  })

  it('恢复的四种结局分别落到 flash 与 error 两条通道', () => {
    /*
      成功走 flash，其余走 error —— 尤其 scanFailed 不能当成功报：
      忽略解除是真的，账号却还没回到池里。
    */
    expect(poolCardCode).toContain('if (restoreSucceeded(outcome)) setFlash(message)')
    expect(poolCardCode).toContain('else setError(message)')
  })
})

describe('恢复走的是 ignore 路由的 ignored=false 分支', () => {
  it('body 里带 accountId 与 ignored: false', () => {
    const body = poolCardCode.slice(
      poolCardCode.indexOf('const restoreIgnored = async'),
      poolCardCode.indexOf('const restoreIgnored = async') + 2200,
    )
    expect(body).toContain('POOL_ACCOUNT_IGNORE_PATH')
    expect(body).toContain('body: JSON.stringify({ accountId: entry.id, ignored: false })')
  })

  it('写成功后回读两区，而不是只回读发起恢复的那一区', () => {
    // 忽略清单是全池数据（4.3），只读一区会让另一区的行停在旧状态。
    const body = poolCardCode.slice(
      poolCardCode.indexOf('const restoreIgnored = async'),
      poolCardCode.indexOf('const restoreIgnored = async') + 2200,
    )
    expect(body).toContain('REGION_CARDS.map(async region =>')
  })

  it('写失败时不再回读，直接按失败报', () => {
    // 回读一次会让界面表现出"它可能已经好了"，而它根本没被动过。
    const body = poolCardCode.slice(
      poolCardCode.indexOf('const restoreIgnored = async'),
      poolCardCode.indexOf('const restoreIgnored = async') + 2200,
    )
    expect(body).toContain("if (!response.ok) {")
    expect(body).toContain("kind: 'failed'")
  })
})

describe('恢复相关的 locale 键已被真正使用', () => {
  it('四个 ignored 键在界面上出现', () => {
    /*
      这四个键 3.2.0 就写好了，却一个都没被引用 —— 这就是"设计做完了、
      接线漏了"的证据。现在它们必须出现在渲染代码里。
    */
    for (const key of [
      'row.ignoredTitle',
      'row.ignoredSummary',
      'row.ignoredRestore',
      'row.ignoredRestoreHint',
    ]) {
      expect(sectionCode, key).toContain(key)
    }
  })
})
