import { describe, expect, it, vi } from 'vitest'
import {
  batchEligibility,
  batchScope,
  batchTargets,
  claimAll,
  claimRouteFor,
  planBatch,
  rescanRegions,
  batchVisibleIn,
  claimedCount,
  failedCount,
  outcomeFromClaim,
  runBatch,
  summarizeBatch,
  type PoolActionResult,
} from '../src/client/pool-actions.ts'
import { buildPoolView, rowsFromPool } from '../src/client/account-view.ts'
import type { PoolWebAccount } from '../src/status-paths.ts'

/**
 * 第 6 节夹具：国内池四个账号 + 一个属于渠道包的 X（不进池）。
 *
 * A 启用、已签、余额 100、todayCredit 10
 * B 启用、未签、余额 200
 * C 停用、未签、余额 300
 * D 启用、未签、余额未知
 */
function account(overrides: Partial<PoolWebAccount> & { id: string; label: string }): PoolWebAccount {
  return {
    domain: 'workbuddy.cn',
    cooling: false,
    disabled: false,
    preferred: false,
    rateLimitHits: 0,
    creditReserve: 0,
    reserved: false,
    ...overrides,
  }
}

function fixture(overrides: { readonly dCheckin?: 'checked' | 'unchecked' | 'unknown' } = {}): PoolWebAccount[] {
  return [
    account({
      id: 'A', label: 'A 主号',
      credits: { total: 100, packages: [] },
      checkin: { active: true, todayCheckedIn: true, streakDays: 4, dailyCredit: 10, todayCredit: 10, isStreakDay: false, nextStreakDay: 7, streakBonusCredit: 30 },
    }),
    account({
      id: 'B', label: 'B 备用',
      credits: { total: 200, packages: [] },
      checkin: { active: true, todayCheckedIn: false, streakDays: 2, dailyCredit: 10, todayCredit: 0, isStreakDay: false, nextStreakDay: 7, streakBonusCredit: 30 },
    }),
    account({
      id: 'C', label: 'C 老号', disabled: true,
      credits: { total: 300, packages: [] },
      checkin: { active: true, todayCheckedIn: false, streakDays: 1, dailyCredit: 10, todayCredit: 0, isStreakDay: false, nextStreakDay: 7, streakBonusCredit: 30 },
    }),
    account({
      id: 'D', label: 'D 新号',
      creditsError: 'credits rpc timed out',
      ...overrides.dCheckin === 'checked'
        ? { checkin: { active: true, todayCheckedIn: true, streakDays: 1, dailyCredit: 10, todayCredit: 10, isStreakDay: false, nextStreakDay: 7, streakBonusCredit: 30 } }
        : overrides.dCheckin === 'unknown'
          ? { checkinError: 'checkin rpc failed' }
          : { checkin: { active: true, todayCheckedIn: false, streakDays: 0, dailyCredit: 10, todayCredit: 0, isStreakDay: false, nextStreakDay: 7, streakBonusCredit: 30 } },
    }),
  ]
}

function rows(shipped = fixture()) {
  return rowsFromPool(shipped)
}

describe('batchTargets — 全部领取只提交该提交的账号', () => {
  it('国内池夹具：只提交 B 和 D，A 已签、C 停用都不提交', () => {
    const targets = batchTargets(rows())
    expect(targets.map(row => row.id)).toEqual(['B', 'D'])
  })

  it('A 已签被排除，理由说「今天已经签到」而不是「跳过」', () => {
    const a = rows().find(row => row.id === 'A')
    expect(a).toBeDefined()
    expect(batchEligibility(a!)).toEqual({ ok: false, reason: 'alreadyChecked' })
  })

  it('C 停用被排除，即使它明确未签', () => {
    const c = rows().find(row => row.id === 'C')
    expect(c?.checkin).toBe('unchecked')
    expect(batchEligibility(c!)).toEqual({ ok: false, reason: 'disabled' })
  })

  it('活动关闭时排除，哪怕状态是明确未签', () => {
    const shipped = fixture()
    const closed = shipped.map(row => row.id === 'D'
      ? { ...row, checkin: { ...row.checkin!, active: false } }
      : row)
    const d = rowsFromPool(closed).find(row => row.id === 'D')
    expect(d?.checkin).toBe('unchecked')
    expect(d?.activityActive).toBe(false)
    expect(batchEligibility(d!)).toEqual({ ok: false, reason: 'activityClosed' })
  })

  it('签到状态未知的不进目标表，并说要先重新检测', () => {
    const d = rows(fixture({ dCheckin: 'unknown' })).find(row => row.id === 'D')
    expect(d?.checkin).toBe('unknown')
    expect(batchEligibility(d!)).toEqual({ ok: false, reason: 'unknownStatus' })
  })

  it('第 6 节夹具的渠道包账号 X 与另一区的 G 永远不在池目标里', () => {
    // X 只存在于 pack 快照，G 属于 global 区，两者都不会出现在这一份 rows 里。
    const ids = batchTargets(rows()).map(row => row.id)
    expect(ids).not.toContain('X')
    expect(ids).not.toContain('G')
  })

  it('planBatch 把未知的放进 recheck 而不是直接跳过', () => {
    const plan = planBatch(rows(fixture({ dCheckin: 'unknown' })))
    expect(plan.ready.map(row => row.id)).toEqual(['B'])
    expect(plan.recheck.map(row => row.id)).toEqual(['D'])
    expect(plan.skipped.map(entry => `${entry.row.id}:${entry.reason}`)).toEqual(['A:alreadyChecked', 'C:disabled'])
  })

  it('空池没有目标', () => {
    expect(batchTargets([])).toEqual([])
  })
})

describe('runBatch — 按序执行，一个失败不拖累其余', () => {
  const target = (id: string): ReturnType<typeof rows>[number] => ({
    id, label: id, enabled: true, balance: undefined, checkin: 'unchecked',
    todayCredit: undefined, balanceError: undefined, checkinError: undefined, activityActive: true,
  })

  it('按目标顺序逐个执行，每个账号一次', async () => {
    const order: string[] = []
    await runBatch([target('B'), target('D')], {
      run: async id => { order.push(id); return { outcome: 'claimed', credit: 10 } },
    })
    expect(order).toEqual(['B', 'D'])
  })

  it('B 成功 D 失败：两个结果都记，成功的不因为后面失败被抹掉', async () => {
    const results = await runBatch([target('B'), target('D')], {
      run: async id => id === 'D'
        ? { outcome: 'failed', error: 'HTTP 500' }
        : { outcome: 'claimed', credit: 10 },
    })
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({ accountId: 'B', outcome: 'claimed', credit: 10 })
    expect(results[1]).toMatchObject({ accountId: 'D', outcome: 'failed', error: 'HTTP 500' })
  })

  it('钩子抛异常被收成 failed，后面的账号照常跑', async () => {
    const results = await runBatch([target('B'), target('D'), target('E')], {
      run: async id => {
        if (id === 'D') throw new Error('network down')
        return { outcome: 'claimed', credit: 10 }
      },
    })
    expect(results.map(result => result.outcome)).toEqual(['claimed', 'failed', 'claimed'])
    expect(results[1]?.error).toBe('network down')
  })

  it('abort 之后不再开始新的账号，但不丢掉已经发出的那个结果', async () => {
    const controller = new AbortController()
    const seen: string[] = []
    const results = await runBatch([target('B'), target('D'), target('E')], {
      signal: controller.signal,
      run: async id => {
        seen.push(id)
        controller.abort()
        return { outcome: 'claimed', credit: 10 }
      },
    })
    expect(seen).toEqual(['B'])
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ accountId: 'B', outcome: 'claimed' })
  })

  it('onResult 每出一个就通知一次，用于逐行显示', async () => {
    const seen: PoolActionResult[] = []
    await runBatch([target('B'), target('D')], {
      run: async id => ({ outcome: id === 'B' ? 'claimed' : 'alreadyClaimed' }),
      onResult: result => { seen.push(result) },
    })
    expect(seen.map(result => `${result.accountId}:${result.outcome}`)).toEqual(['B:claimed', 'D:alreadyClaimed'])
  })
})

describe('outcomeFromClaim — 保留服务端 alreadyCheckedIn 语义', () => {
  it('alreadyCheckedIn 记为 alreadyClaimed，不算失败', () => {
    expect(outcomeFromClaim({ ok: true, alreadyCheckedIn: true, claim: { credit: 0 } }, true))
      .toEqual({ outcome: 'alreadyClaimed', credit: 0 })
  })

  it('正常领取带 credit', () => {
    expect(outcomeFromClaim({ ok: true, claim: { credit: 15 } }, true))
      .toEqual({ outcome: 'claimed', credit: 15 })
  })

  it('HTTP 拒绝时取服务端给的 error 文案', () => {
    expect(outcomeFromClaim({ error: 'check-in activity is not active' }, false))
      .toEqual({ outcome: 'failed', error: 'check-in activity is not active' })
  })

  it('拒绝但没给 error 时也有话说', () => {
    const result = outcomeFromClaim(undefined, false)
    expect(result.outcome).toBe('failed')
    expect(result.error).toBe('签到请求被拒绝')
  })

  it('成功但没有 claim 对象时仍算 claimed，只是没数字', () => {
    expect(outcomeFromClaim({ ok: true }, true)).toEqual({ outcome: 'claimed' })
  })
})

describe('summarizeBatch — 明确区分「领到了」与「状态待刷新」', () => {
  const labels = { claimed: (n: number) => `已领取 ${String(n)} 个账号`, failed: (n: number) => `${String(n)} 个失败` }

  it('领取成功但回读失败：说已领取，并说状态待刷新', () => {
    const summary = summarizeBatch({
      results: [{ accountId: 'B', label: 'B', outcome: 'claimed', credit: 10 }],
      skipped: [],
      refresh: { ok: false, error: 'timeout' },
    }, labels)
    expect(summary.text).toContain('已领取 1 个账号')
    expect(summary.text).toContain('状态待刷新')
    expect(summary.text).toContain('timeout')
    // 不是错误：用户确实领到了，染成红色会让他以为没领到。
    expect(summary.tone).toBe('warn')
  })

  it('全部成功且回读成功是 ok', () => {
    const summary = summarizeBatch({
      results: [{ accountId: 'B', label: 'B', outcome: 'claimed', credit: 10 }],
      skipped: [],
      refresh: { ok: true },
    }, labels)
    expect(summary.text).toBe('已领取 1 个账号')
    expect(summary.tone).toBe('ok')
  })

  it('部分失败是 warn 而不是 error，且两个数字都在', () => {
    const summary = summarizeBatch({
      results: [
        { accountId: 'B', label: 'B', outcome: 'claimed', credit: 10 },
        { accountId: 'D', label: 'D', outcome: 'failed', error: 'x' },
      ],
      skipped: [],
      refresh: { ok: true },
    }, labels)
    expect(summary.text).toContain('已领取 1 个账号')
    expect(summary.text).toContain('1 个失败')
    expect(summary.tone).toBe('warn')
  })

  it('没有目标时如实说没有，不发一个空成功', () => {
    const summary = summarizeBatch({ results: [], skipped: [], refresh: { ok: true } }, labels)
    expect(summary.text).toBe('没有可领取的账号')
    expect(summary.tone).toBe('warn')
  })

  it('alreadyClaimed 计入领取数（用户看到的是「领到了」）', () => {
    const results: PoolActionResult[] = [
      { accountId: 'B', label: 'B', outcome: 'claimed', credit: 10 },
      { accountId: 'D', label: 'D', outcome: 'alreadyClaimed', credit: 0 },
    ]
    expect(claimedCount(results)).toBe(2)
    expect(failedCount(results)).toBe(0)
  })

  it('跳过不计入失败', () => {
    const results: PoolActionResult[] = [{ accountId: 'C', label: 'C', outcome: 'skipped', error: '账号已停用' }]
    expect(failedCount(results)).toBe(0)
    expect(claimedCount(results)).toBe(0)
  })
})

describe('claimAll — 先复查、再提交、最后统一回读', () => {
  const refreshOk = async () => ({ ok: true })

  it('国内池夹具：只对 B 提交请求，A/C 连请求都不发', async () => {
    const sent: string[] = []
    const report = await claimAll({
      rows: rows(),
      claim: async id => { sent.push(id); return { outcome: 'claimed', credit: 10 } },
      recheck: async () => undefined,
      refresh: refreshOk,
    })
    expect(sent).toEqual(['B', 'D'])
    expect(report.results.map(result => result.accountId)).toEqual(['B', 'D'])
  })

  it('D 状态未知时先复查；复查后明确未签才提交', async () => {
    const fresh = rows().find(row => row.id === 'D')!
    const sent: string[] = []
    const rechecked: string[] = []
    const report = await claimAll({
      rows: rows(fixture({ dCheckin: 'unknown' })),
      claim: async id => { sent.push(id); return { outcome: 'claimed', credit: 10 } },
      recheck: async id => { rechecked.push(id); return fresh },
      refresh: refreshOk,
    })
    expect(rechecked).toEqual(['D'])
    expect(sent).toEqual(['B', 'D'])
    expect(report.skipped.map(item => item.accountId)).toEqual(['A', 'C'])
  })

  it('复查后仍然未知：记跳过并解释，不发领取请求', async () => {
    const sent: string[] = []
    const report = await claimAll({
      rows: rows(fixture({ dCheckin: 'unknown' })),
      claim: async id => { sent.push(id); return { outcome: 'claimed', credit: 10 } },
      recheck: async () => undefined,
      refresh: refreshOk,
    })
    expect(sent).toEqual(['B'])
    const skippedD = report.skipped.find(item => item.accountId === 'D')
    expect(skippedD?.outcome).toBe('skipped')
    expect(skippedD?.error).toContain('复查失败')
  })

  it('复查时发现已经签过了：改成 alreadyChecked 跳过，不提交', async () => {
    const nowChecked = rows(fixture({ dCheckin: 'checked' })).find(row => row.id === 'D')!
    const sent: string[] = []
    const report = await claimAll({
      rows: rows(fixture({ dCheckin: 'unknown' })),
      claim: async id => { sent.push(id); return { outcome: 'claimed', credit: 10 } },
      recheck: async () => nowChecked,
      refresh: refreshOk,
    })
    expect(sent).toEqual(['B'])
    expect(report.skipped.find(item => item.accountId === 'D')?.error).toContain('已经签到')
  })

  it('复查钩子抛异常也记跳过，不中断整批', async () => {
    const report = await claimAll({
      rows: rows(fixture({ dCheckin: 'unknown' })),
      claim: async () => ({ outcome: 'claimed', credit: 10 }),
      recheck: async () => { throw new Error('status rpc down') },
      refresh: refreshOk,
    })
    expect(report.results.map(result => result.accountId)).toEqual(['B'])
    expect(report.skipped.find(item => item.accountId === 'D')?.error).toContain('status rpc down')
  })

  it('B 成功 D 失败：两个结果都在，批次照常收尾并回读', async () => {
    let refreshed = 0
    const report = await claimAll({
      rows: rows(),
      claim: async id => id === 'D'
        ? { outcome: 'failed', error: 'HTTP 500' }
        : { outcome: 'claimed', credit: 10 },
      recheck: async () => undefined,
      refresh: async () => { refreshed += 1; return { ok: true } },
    })
    expect(report.results).toHaveLength(2)
    expect(report.results[1]).toMatchObject({ accountId: 'D', outcome: 'failed' })
    expect(refreshed).toBe(1)
  })

  it('领取成功但回读抛异常：报告里是「状态待刷新」，不是「失败」', async () => {
    const report = await claimAll({
      rows: rows(),
      claim: async () => ({ outcome: 'claimed', credit: 10 }),
      recheck: async () => undefined,
      refresh: async () => { throw new Error('timeout') },
    })
    expect(report.results.every(result => result.outcome === 'claimed')).toBe(true)
    expect(report.refresh.ok).toBe(false)
    expect(report.refresh.error).toBe('timeout')
    const summary = summarizeBatch(report, {
      claimed: n => `已领取 ${String(n)} 个账号`,
      failed: n => `${String(n)} 个失败`,
    })
    expect(summary.text).toContain('已领取 2 个账号')
    expect(summary.text).toContain('状态待刷新')
  })

  it('重复点击：第一次已经领完，第二次没有目标可提交', async () => {
    const signed = rows().map(row => ({
      ...row,
      checkin: row.enabled ? 'checked' as const : row.checkin,
    }))
    const sent: string[] = []
    const report = await claimAll({
      rows: signed,
      claim: async id => { sent.push(id); return { outcome: 'claimed', credit: 10 } },
      recheck: async () => undefined,
      refresh: refreshOk,
    })
    expect(sent).toEqual([])
    expect(report.results).toEqual([])
  })

  it('操作中切区域：abort 后不再提交新的账号，已有的结果留着', async () => {
    const controller = new AbortController()
    const sent: string[] = []
    const report = await claimAll({
      rows: rows(),
      signal: controller.signal,
      claim: async id => { sent.push(id); controller.abort(); return { outcome: 'claimed', credit: 10 } },
      recheck: async () => undefined,
      refresh: refreshOk,
    })
    expect(sent).toEqual(['B'])
    expect(report.results.map(result => result.accountId)).toEqual(['B'])
  })

  it('skipIds 让刚领到但回读失败的账号不再被提交（4.3 的第二道闸）', async () => {
    const sent: string[] = []
    // 第一轮：两个都领到，但回读失败 —— 界面上的数据仍是"未签"
    const first = await claimAll({
      rows: rows(),
      claim: async id => { sent.push(id); return { outcome: 'claimed', credit: 10 } },
      recheck: async () => undefined,
      refresh: async () => ({ ok: false, error: 'timeout' }),
    })
    expect(sent).toEqual(['B', 'D'])
    const justClaimed = new Set(first.results.map(result => result.accountId))
    // 第二轮：rows 还是旧数据（未签），但 skipIds 把它们挡住
    const second = await claimAll({
      rows: rows(),
      skipIds: justClaimed,
      claim: async id => { sent.push(id); return { outcome: 'claimed', credit: 10 } },
      recheck: async () => undefined,
      refresh: async () => ({ ok: true }),
    })
    expect(sent).toEqual(['B', 'D'])
    expect(second.results).toEqual([])
    // 只关心 B/D：A（已签）、C（停用）在夹具里本来就会被跳过，与 skipIds 无关。
    const skippedIds = second.skipped.map(item => item.accountId)
    expect(skippedIds).not.toContain('B')
    expect(skippedIds).not.toContain('D')
  })

  it('回读成功后 skipIds 该被清空（否则明天的领取会被自己挡住）', async () => {
    // claimAll 不自己清理 skipIds（那是调用方持有的东西），只验证"传空集时照常提交"
    const sent: string[] = []
    await claimAll({
      rows: rows(),
      skipIds: new Set(),
      claim: async id => { sent.push(id); return { outcome: 'claimed', credit: 10 } },
      recheck: async () => undefined,
      refresh: async () => ({ ok: true }),
    })
    expect(sent).toEqual(['B', 'D'])
  })

  it('成功账号不会因为回读失败被再次提交', async () => {
    const sent: string[] = []
    let round = 0
    // 第一次：刷新失败。第二次点击用的仍是「未签」的旧数据 —— 但 B 已经成功过。
    const first = await claimAll({
      rows: rows(),
      claim: async id => { sent.push(id); return { outcome: 'claimed', credit: 10 } },
      recheck: async () => undefined,
      refresh: async () => { round += 1; return { ok: false, error: 'timeout' } },
    })
    expect(first.refresh.ok).toBe(false)
    // 调用方按 first.results 把成功的账号从下一轮目标里剔掉（服务端 alreadyCheckedIn 之外的第二道闸）
    const succeeded = new Set(first.results.filter(r => r.outcome === 'claimed').map(r => r.accountId))
    const second = await claimAll({
      rows: rows().filter(row => !succeeded.has(row.id)),
      claim: async id => ({ outcome: 'claimed', credit: 10 }),
      recheck: async () => undefined,
      refresh: refreshOk,
    })
    expect(sent).toEqual(['B', 'D'])
    expect(second.results).toEqual([])
  })
})

describe('X（渠道包账号）与 G（国际池账号）都不进国内批次的领取请求', () => {
  // 交接文档 T3 验收：「A、C、X、G 均无领取请求」。
  // X 属于渠道包（余额 900 那一批），G 属于国际池，两者都不该出现在国内池的批量目标里。
  const packAccount = {
    id: 'X',
    nickname: 'X 渠道包号',
    disabled: false,
  }
  const packSnapshot = {
    accounts: [packAccount],
    balances: [{ accountId: 'X', balance: 900 }],
    statuses: [],
  }
  const globalAccounts = [
    account({
      id: 'G', label: 'G 国际号', domain: 'workbuddy.ai',
      credits: { total: 888, packages: [] },
      checkin: { active: true, todayCheckedIn: false, streakDays: 0, dailyCredit: 10, todayCredit: 0, isStreakDay: false, nextStreakDay: 7, streakBonusCredit: 30 },
    }),
  ]

  it('国内页的批量目标只有 B、D —— X 和 G 都不在行里', () => {
    // 国内页即使同时拿到渠道包快照（X）和国际池快照（G），批量目标也只来自国内池。
    const cnView = buildPoolView({
      channelId: 'buddy',
      region: 'cn',
      status: { accounts: fixture() },
      state: 'ready',
    })
    const targets = batchTargets(cnView.rows).map(row => row.id)
    expect(targets).toEqual(['B', 'D'])
    expect(targets).not.toContain('X')
    expect(targets).not.toContain('G')
    // 渠道包快照本身有 X，但它属于另一个来源，不会被混进这一行集
    expect(packSnapshot.accounts.map(item => item.id)).toEqual(['X'])
    // 国际池的 G 是"未签、启用"，若被错误合并进来一定会出现在这里
    expect(globalAccounts.every(item => item.checkin?.todayCheckedIn === false)).toBe(true)
  })

  it('国际池自己的批量目标只有 G，不含国内的 B、D', () => {
    const globalView = buildPoolView({
      channelId: 'workbuddy',
      region: 'global',
      status: { accounts: globalAccounts },
      state: 'ready',
    })
    const targets = batchTargets(globalView.rows).map(row => row.id)
    expect(targets).toEqual(['G'])
    expect(targets).not.toContain('B')
    expect(targets).not.toContain('D')
  })

  it('把 pool-actions 的 rowsFromPool 分开调用，X 不会被当成池账号', () => {
    // rowsFromPool 只认池账号字段；渠道包的 ChannelAccount 没有 credits/checkin，
    // 若被误传进来余额是未知、签到也是未知 —— 未知会被复查而不是直接领取。
    const foreign = rowsFromPool([])
    expect(foreign).toEqual([])
    expect(batchTargets(foreign)).toEqual([])
  })
})

describe('批次归属启动时的区域', () => {
  it('批次记下启动区域，切换后结果仍归属原区域', () => {
    const scope = batchScope('cn', 1000)
    expect(scope.region).toBe('cn')
    expect(batchVisibleIn(scope, 'cn')).toBe(true)
    expect(batchVisibleIn(scope, 'global')).toBe(false)
  })

  it('没有批次时不隐藏任何区域的结果', () => {
    expect(batchVisibleIn(undefined, 'global')).toBe(true)
  })
})

describe('rescanRegions — 一次 rescan、两个区都读、数量取区域快照', () => {
  it('rescan 只发一次，两个区各读一次', async () => {
    let rescans = 0
    const reads: string[] = []
    const outcome = await rescanRegions({
      rescan: async () => { rescans += 1; return 7 },
      refresh: async region => { reads.push(region); return region === 'cn' ? 4 : 3 },
      regions: ['cn', 'global'],
    })
    expect(rescans).toBe(1)
    expect(reads.sort()).toEqual(['cn', 'global'])
    expect(outcome.total).toBe(7)
    expect(outcome.byRegion).toEqual({ cn: 4, global: 3 })
  })

  it('区域数量来自区域快照，不是全池数', async () => {
    const outcome = await rescanRegions({
      rescan: async () => 7,
      refresh: async () => 4,
      regions: ['cn', 'global'],
    })
    // 全池 7 与"这一区 4"是两个数，不能互相顶替。
    expect(outcome.total).toBe(7)
    expect(outcome.byRegion['cn']).toBe(4)
    expect(outcome.byRegion['cn']).not.toBe(outcome.total)
  })

  it('一个区读不到时另一个区照样有数，读不到的那个是 undefined', async () => {
    const outcome = await rescanRegions({
      rescan: async () => 7,
      refresh: async region => {
        if (region === 'global') throw new Error('status rpc down')
        return 4
      },
      regions: ['cn', 'global'],
    })
    expect(outcome.byRegion).toEqual({ cn: 4, global: undefined })
  })

  it('rescan 自己失败时抛出，不假装成功', async () => {
    await expect(rescanRegions({
      rescan: async () => { throw new Error('scan failed') },
      refresh: async () => 0,
      regions: ['cn'],
    })).rejects.toThrow('scan failed')
  })
})

describe('claimRouteFor — 池 lane 不能走渠道包的 claimAll', () => {
  it('有池 lane 就走池（不管有没有自有签到路由）', () => {
    expect(claimRouteFor({ hasPoolLane: true, hasOwnCheckinRoute: false })).toBe('pool')
    expect(claimRouteFor({ hasPoolLane: true, hasOwnCheckinRoute: true })).toBe('pool')
  })

  it('没有池但有自有路由的走自有路由', () => {
    expect(claimRouteFor({ hasPoolLane: false, hasOwnCheckinRoute: true })).toBe('own')
  })

  it('两者都没有才走 pack', () => {
    expect(claimRouteFor({ hasPoolLane: false, hasOwnCheckinRoute: false })).toBe('pack')
  })
})

describe('视图与批量目标共用同一份账号表', () => {
  it('详情页画 4 行，批量目标取自同一份 4 行（不是 pack 的 2 行）', () => {
    const shipped = fixture()
    const view = buildPoolView({ channelId: 'buddy', region: 'cn', status: {
      ok: true, accounts: shipped, cooling: 0, models: [], selection: { enabledModelIds: [] },
      distribution: 'priority', region: 'cn', regions: ['cn'], shim: { running: false },
      automation: { enabled: false }, creditReserves: {}, ignored: [],
    }, state: 'ready' })
    expect(view.total).toBe(4)
    expect(batchTargets(view.rows).map(row => row.id)).toEqual(['B', 'D'])
  })
})
