import { describe, expect, it } from 'vitest'
import { creditStatusesFrom } from '../src/client/channel-rpc.ts'
import { buildPageView, rowsFromChannel } from '../src/client/account-view.ts'

/**
 * 交接文档 4.4 / T4：
 *
 * - 「creditStatusesFrom 保留显式 true 和 false，缺失保持未知；
 *    RPC 失败的外层状态也必须传到视图。」
 * - 「仅支持手动领取的渠道展示未知签到状态。」
 *
 * 第 6 节夹具里的第三方渠道 P：分别模拟状态 true、false、缺失、RPC 失败，
 * 以及仅支持手动动作。
 */

/** 一次成功的 credits.status 答复。 */
function envelope(accounts: readonly unknown[]) {
  return { ok: true as const, value: { accounts } }
}

function statusRow(accountId: string, status: unknown) {
  return { accountId, status }
}

describe('creditStatusesFrom — 显式 true/false/缺失三态', () => {
  it('显式 true 是已签', () => {
    const rows = creditStatusesFrom(envelope([
      statusRow('P1', { todayCheckedIn: true, todayCredit: 12 }),
    ]))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.todayCheckedIn).toBe(true)
    expect(rows[0]?.todayCredit).toBe(12)
  })

  it('显式 false 是未签，不是"没有这个字段"（F4 的核心）', () => {
    /*
      3.2.0 写的是 `statusRow?.['todayCheckedIn'] === true ? {todayCheckedIn:true} : {}`，
      于是 false 被整条丢掉。丢掉之后下游只能看到"字段不存在"，按 4.2 的口径就是未知，
      而真相是"问到了、今天没签"。这一条就是钉住那个分支。
    */
    const rows = creditStatusesFrom(envelope([
      statusRow('P1', { todayCheckedIn: false, todayCredit: 0 }),
    ]))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.todayCheckedIn).toBe(false)
  })

  it('字段缺失保持未知：不写这一格', () => {
    const rows = creditStatusesFrom(envelope([statusRow('P1', { todayCredit: 5 })]))
    expect(rows[0]).toEqual({ accountId: 'P1', todayCredit: 5 })
    expect(Object.hasOwn(rows[0] ?? {}, 'todayCheckedIn')).toBe(false)
  })

  it('status 整块缺失也保持未知', () => {
    const rows = creditStatusesFrom(envelope([{ accountId: 'P1' }]))
    expect(rows).toEqual([{ accountId: 'P1' }])
  })

  it('非布尔的 todayCheckedIn 不算三态里的任何一个', () => {
    // 'true' 字符串、1、null 都不该被当成 true —— 那是上游契约之外的输入。
    for (const bogus of ['true', 1, null, {}]) {
      const rows = creditStatusesFrom(envelope([statusRow('P1', { todayCheckedIn: bogus })]))
      expect(Object.hasOwn(rows[0] ?? {}, 'todayCheckedIn')).toBe(false)
    }
  })
})

describe('RPC 失败的外层状态传到视图', () => {
  /**
   * 整次 credits.status 失败的快照。
   *
   * 没有 statusError 这一格时，"问不到"与"没签"在视图里完全一样：statuses 是空数组，
   * 每个账号都算未知，而理由空白 —— 页面只能画一个不知道从哪来的未知。
   */
  function snapshotWithFailure(statusError: string | undefined) {
    return {
      accounts: [
        { id: 'P1', nickname: 'P1 主号', enabled: true },
        { id: 'P2', nickname: 'P2 备用', enabled: true },
      ],
      balances: [
        { accountId: 'P1', balance: 100 },
        { accountId: 'P2', balance: 200 },
      ],
      statuses: [],
      ...statusError === undefined ? {} : { statusError },
    }
  }

  it('失败原因落在每一行的 checkinError 上', () => {
    const rows = rowsFromChannel(snapshotWithFailure('credits.status refused'))
    expect(rows.map(row => row.checkinError)).toEqual([
      'credits.status refused',
      'credits.status refused',
    ])
    expect(rows.map(row => row.checkin)).toEqual(['unknown', 'unknown'])
  })

  it('失败时签到分母仍然是启用的账号数（不是 0）', () => {
    // 分母取 0 会让「今日已领 0/0」看起来像"没有账号"，而不是"没问到"。
    const view = buildPageView({
      channel: { id: 'trae' },
      pack: snapshotWithFailure('credits.status refused'),
      state: 'ready',
    })
    expect(view.checkin.denominator).toBe(2)
    expect(view.checkin.unknown).toBe(2)
    expect(view.checkin.checked).toBe(0)
    expect(view.checkin.allDone).toBe(false)
  })

  it('没声明 status 能力的渠道：statuses 为空，但没有错误理由', () => {
    // 「仅支持手动领取」的渠道应该显示未知签到状态，而不是一个失败提示。
    const rows = rowsFromChannel(snapshotWithFailure(undefined))
    expect(rows.map(row => row.checkin)).toEqual(['unknown', 'unknown'])
    expect(rows.map(row => row.checkinError)).toEqual([undefined, undefined])
  })
})

describe('第三方渠道 P 的四种状态组合（第 6 节夹具）', () => {
  function pView(statuses: readonly { accountId: string; todayCheckedIn?: boolean; todayCredit?: number }[], statusError?: string) {
    return buildPageView({
      channel: { id: 'trae' },
      pack: {
        accounts: [
          { id: 'P1', nickname: 'P 主号', enabled: true },
          { id: 'P2', nickname: 'P 备用', enabled: true },
        ],
        balances: [
          { accountId: 'P1', balance: 100 },
          { accountId: 'P2', balance: 200 },
        ],
        statuses,
        ...statusError === undefined ? {} : { statusError },
      },
      state: 'ready',
    })
  }

  it('true + false：一签一未签，分母 2', () => {
    const view = pView([
      { accountId: 'P1', todayCheckedIn: true, todayCredit: 8 },
      { accountId: 'P2', todayCheckedIn: false },
    ])
    expect(view.checkin.checked).toBe(1)
    expect(view.checkin.unchecked).toBe(1)
    expect(view.checkin.unknown).toBe(0)
    expect(view.checkin.denominator).toBe(2)
    expect(view.checkin.todayCredit).toBe(8)
    expect(view.checkin.allDone).toBe(false)
  })

  it('缺失：两个都算未知，分母仍是 2', () => {
    const view = pView([])
    expect(view.checkin.unknown).toBe(2)
    expect(view.checkin.denominator).toBe(2)
    expect(view.checkin.checked).toBe(0)
  })

  it('RPC 失败：与缺失区分开 —— 理由是有的', () => {
    const missing = pView([])
    const failed = pView([], 'unsupported provider')
    // 数字层面两者都未知（都问不到），所以不能靠数字分辨；区别在 checkinError。
    expect(failed.checkin).toEqual(missing.checkin)
    expect(failed.rows[0]?.checkinError).toBe('unsupported provider')
    expect(missing.rows[0]?.checkinError).toBeUndefined()
  })

  it('全部明确已签时 allDone 才为 true', () => {
    const view = pView([
      { accountId: 'P1', todayCheckedIn: true, todayCredit: 8 },
      { accountId: 'P2', todayCheckedIn: true, todayCredit: 8 },
    ])
    expect(view.checkin.allDone).toBe(true)
    expect(view.checkin.todayCredit).toBe(16)
  })
})

describe('池来源不受 statusError 影响', () => {
  it('池 lane 的签到状态来自池快照，pack 的 statusError 不该渗进去', () => {
    /*
      buddy 归池管，所以这一页读的是池快照。pack 那边的 statusError 说的是渠道包的
      credits.status，与池无关；渗进来会让整池四个账号莫名其妙显示"签到读取失败"。
    */
    const view = buildPageView({
      channel: { id: 'buddy', ownedByPool: true },
      laneAccounts: [
        {
          id: 'A', label: 'A 主号', domain: 'workbuddy.cn', cooling: false,
          disabled: false, preferred: false, rateLimitHits: 0, creditReserve: 0, reserved: false,
          credits: { total: 100, packages: [] },
          checkin: {
            active: true, todayCheckedIn: true, streakDays: 4, dailyCredit: 10,
            todayCredit: 10, isStreakDay: false, nextStreakDay: 7, streakBonusCredit: 30,
          },
        },
      ],
      pack: {
        accounts: [{ id: 'X', nickname: 'X', enabled: true }],
        balances: [{ accountId: 'X', balance: 900 }],
        statuses: [],
        statusError: 'credits.status refused',
      },
      state: 'ready',
    })
    expect(view.rows.map(row => row.id)).toEqual(['A'])
    expect(view.rows[0]?.checkinError).toBeUndefined()
    expect(view.checkin.checked).toBe(1)
  })
})
