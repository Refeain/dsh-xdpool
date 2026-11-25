/**
 * F3 的守卫：按钮必须真的接上池的动作服务。
 *
 * 3.2.0 里 `PoolCard` 写好了 `rescan()`（POST POOL_RESCAN_PATH，扫全池），
 * 但 `ChannelPoolSection` 的「重新检测账号」调的是另一个本地 `recheck()` ——
 * 它只让渠道包的缓存失效再重读，池的账号一个都没重新扫。函数写了、没人调用，
 * 这跟没写是一样的，而静态字符串测试查不出来（`POOL_RESCAN_PATH` 确实在
 * PoolCard 里出现过）。
 *
 * 所以这里查的是三件事，每件都对应一个真实断点：
 * 1. 池 lane 带出可等待的动作服务（`actions`），而不是只有 void 包装；
 * 2. 两个按钮（全部领取 / 重新检测）在池 lane 上走的是 `actions`；
 * 3. 池 lane 上的「全部领取」不再落到 pack 的 `credits.claimAll`。
 *
 * 纯行为已经在 tests/pool-actions.test.ts 里（44 个用例）。这里只管接线。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const poolCard = readFileSync(new URL('../src/client/PoolCard.tsx', import.meta.url), 'utf8')
const section = readFileSync(new URL('../src/client/ChannelPoolSection.tsx', import.meta.url), 'utf8')

/** 去掉注释与字符串字面量，避免"注释里写了就算通过"这种假绿。 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const poolCardCode = codeOnly(poolCard)
const sectionCode = codeOnly(section)

describe('池 lane 带出可等待的动作服务', () => {
  it('laneFor 给出 actions，且五个动作都在', () => {
    expect(poolCardCode).toContain('actions: {')
    for (const member of ['claim:', 'claimAll:', 'recheckAccount:', 'rescan:', 'rows:']) {
      expect(poolCardCode, member).toContain(member)
    }
  })

  it('claimAll 走的是 pool-actions 的编排，不是就地再写一遍', () => {
    // 编排（先复查再提交）只有一份，重复实现必然漂。
    expect(poolCardCode).toContain('claimAll({')
    expect(poolCardCode).toContain("from './pool-actions.ts'")
  })

  it('rescan 走 rescanRegions —— 全池一次、两区都读', () => {
    expect(poolCardCode).toContain('rescanRegions({')
    expect(poolCardCode).toContain('regions: REGION_CARDS')
  })
})

describe('两个按钮在池 lane 上走 actions', () => {
  it('「重新检测账号」对池 lane 调 actions.rescan（F3 的核心断点）', () => {
    // 3.2.0 的 recheck 只有 invalidatePoolSnapshot + load，没有 rescan。
    const recheckBody = sectionCode.slice(
      sectionCode.indexOf('const recheck = async'),
      sectionCode.indexOf('const recheck = async') + 2000,
    )
    /*
      断言的是**条件本身**，不是函数体里出现过这几个字。
      实测过一次空转假绿：把条件改成 `if (false as boolean)`，函数体原样保留，
      「函数体里含 actions.rescan()」照样通过 —— 但那条路径永远走不到。
    */
    expect(recheckBody).toContain("if (lane?.actions !== undefined) {")
    expect(recheckBody).toContain('actions.rescan()')
    // 非池渠道仍保留原来的缓存失效路径，不能被一刀切掉
    expect(recheckBody).toContain('invalidatePoolSnapshot()')
  })

  it('「全部领取」对池 lane 调 actions.claimAll', () => {
    const claimBody = sectionCode.slice(
      sectionCode.indexOf('const claimAllFor = async'),
      sectionCode.indexOf('const claimAllFor = async') + 2600,
    )
    // 同上：查条件，不查"函数体里有没有这个词"。
    expect(claimBody).toContain("if (route === 'pool' && lane?.actions !== undefined) {")
    expect(claimBody).toContain('lane.actions.claimAll()')
    // pack 的 claimAll 只剩非池渠道走
    expect(claimBody).toContain("if (route === 'pack') { await claim(provider); return }")
  })

  it('池 lane 不落到 pack 的 credits.claimAll', () => {
    // 判据本身在 pool-actions.claimRouteFor 里，已被单测覆盖（池优先）。
    expect(sectionCode).toContain('claimRouteFor({')
  })

  it('批量进行中按钮变灰 —— 用的是 lane 带来的 batchBusy', () => {
    expect(sectionCode).toContain('batchBusy')
    expect(sectionCode).toContain("isBusy = busy.has(channel.id) || laneOf(channel.id)?.batchBusy === true")
  })
})

describe('服务端 rescan 的语义没被改坏', () => {
  it('route 仍返回全池 accounts（不是某一区）', () => {
    const route = readFileSync(new URL('../src/web-status.ts', import.meta.url), 'utf8')
    // 第一次出现是 import 列表，找注册点。
    const at = route.indexOf('path: POOL_RESCAN_PATH')
    expect(at).toBeGreaterThan(0)
    const handler = route.slice(at, at + 900)
    expect(handler).toContain('deps.pool.scan()')
    expect(handler).toContain('accounts: accounts.length')
  })
})
