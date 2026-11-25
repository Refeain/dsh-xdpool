/**
 * T2 验收：同一个账号视图，一套口径。
 *
 * 交接文档第 6 节的固定夹具原样落在这里：国内池 A/B/C/D。这些数字（4、3、1/3、600、3/4）
 * 不是「顺手取的期望值」，而是缺陷 F2 的判据 —— 旧代码给出的是「2 个账号、900 余额」，
 * 因为账号列表来自池、余额合计来自渠道包。同一份输入必须得到一个自洽的视图。
 */
import { describe, expect, it } from 'vitest'
import {
  balanceDisplay,
  buildAccountView,
  buildChannelView,
  buildPageView,
  buildPoolView,
  createRegionGate,
  poolRegionOf,
  resolveAccountSource,
  rowsFromChannel,
  rowsFromPool,
} from '../src/client/account-view.ts'
import type { PoolWebAccount } from '../src/status-paths.ts'

/**
 * 国内池的四个账号，与夹具逐字对应。
 *
 * | 账号 | 启用 | 签到 | 余额 | 说明 |
 * | A | 是 | 已签 | 100 | todayCredit 10 |
 * | B | 是 | 未签 | 200 | 活动开放 |
 * | C | 否 | 未签 | 300 | 停用仍是用户的钱 |
 * | D | 是 | 未签 | 未知 | 活动开放 |
 */
function poolAccount(over: Partial<PoolWebAccount> & { id: string }): PoolWebAccount {
  return {
    label: over.id,
    domain: 'copilot.tencent.com',
    cooling: false,
    disabled: false,
    preferred: false,
    rateLimitHits: 0,
    creditReserve: 0,
    reserved: false,
    ...over,
  }
}

const DOMESTIC: readonly PoolWebAccount[] = [
  poolAccount({
    id: 'A',
    label: '账号 A',
    credits: { total: 100, packages: [] },
    checkin: {
      active: true,
      todayCheckedIn: true,
      streakDays: 3,
      dailyCredit: 10,
      todayCredit: 10,
      isStreakDay: false,
      nextStreakDay: 7,
      streakBonusCredit: 0,
    },
  }),
  poolAccount({
    id: 'B',
    label: '账号 B',
    credits: { total: 200, packages: [] },
    checkin: {
      active: true,
      todayCheckedIn: false,
      streakDays: 0,
      dailyCredit: 10,
      todayCredit: 0,
      isStreakDay: false,
      nextStreakDay: 1,
      streakBonusCredit: 0,
    },
  }),
  poolAccount({
    id: 'C',
    label: '账号 C',
    disabled: true,
    credits: { total: 300, packages: [] },
    checkin: {
      active: true,
      todayCheckedIn: false,
      streakDays: 0,
      dailyCredit: 10,
      todayCredit: 0,
      isStreakDay: false,
      nextStreakDay: 1,
      streakBonusCredit: 0,
    },
  }),
  // D：余额读不到。creditsError 有值，credits 缺席。
  poolAccount({
    id: 'D',
    label: '账号 D',
    creditsError: '余额接口超时',
    checkin: {
      active: true,
      todayCheckedIn: false,
      streakDays: 0,
      dailyCredit: 10,
      todayCredit: 0,
      isStreakDay: false,
      nextStreakDay: 1,
      streakBonusCredit: 0,
    },
  }),
]

function domesticView(accounts: readonly PoolWebAccount[] = DOMESTIC) {
  return buildPoolView({
    channelId: 'buddy',
    region: 'cn',
    status: { accounts },
    state: 'ready',
  })
}

describe('国内池的固定夹具：4 / 3 / 1:3 / 600 / 3:4', () => {
  it('账号 4、启用 3', () => {
    const view = domesticView()
    expect(view.total).toBe(4)
    expect(view.enabled).toBe(3)
    // 「账号」这个总数与列表行数一致，停用的那个仍在列表里。
    expect(view.rows).toHaveLength(4)
  })

  it('已签 1/3 —— 分母是启用的账号，停用的 C 不参与', () => {
    const view = domesticView()
    expect(view.checkin.checked).toBe(1)
    expect(view.checkin.unchecked).toBe(2)
    expect(view.checkin.unknown).toBe(0)
    expect(view.checkin.denominator).toBe(3)
    expect(view.checkin.allDone).toBe(false)
  })

  it('余额小计 600，覆盖 3/4 —— 停用的 C 的 300 也计入', () => {
    const view = domesticView()
    expect(view.balance.known).toBe(600)
    expect(view.balance.measured).toBe(3)
    expect(view.balance.total).toBe(4)
    expect(view.balance.complete).toBe(false)
  })

  it('签到奖励取 10（已签账号今天到账的，不是 dailyCredit）', () => {
    const view = domesticView()
    expect(view.checkin.todayCredit).toBe(10)
  })

  it('部分未知显示「已知余额 + 覆盖数」，不是把 600 当总额', () => {
    expect(balanceDisplay(domesticView().balance)).toEqual({
      kind: 'partial',
      known: 600,
      measured: 3,
      total: 4,
    })
  })

  /**
   * 「将 D 余额设 0 后覆盖 4/4」—— 交接文档 T2 验收明确要求。
   *
   * 这条守的是「零有效、缺失未知」：0 必须计入 measured，否则一个真没钱的账号会让整页
   * 永远显示「已知余额」。
   */
  it('把 D 的余额设成 0 后覆盖 4/4，小计仍是 600', () => {
    const withZero = DOMESTIC.map(account =>
      account.id === 'D' ? { ...account, credits: { total: 0, packages: [] }, creditsError: undefined } : account,
    )
    const view = domesticView(withZero)
    expect(view.balance.known).toBe(600)
    expect(view.balance.measured).toBe(4)
    expect(view.balance.complete).toBe(true)
    expect(balanceDisplay(view.balance)).toEqual({ kind: 'complete', known: 600 })
  })

  it('NaN 与 Infinity 都按未知处理，不污染小计', () => {
    const broken = DOMESTIC.map(account =>
      account.id === 'A' ? { ...account, credits: { total: Number.NaN, packages: [] } } : account,
    )
    const view = domesticView(broken)
    expect(view.rows.find(row => row.id === 'A')?.balance).toBeUndefined()
    expect(view.balance.known).toBe(500)
    expect(view.balance.measured).toBe(2)
  })

  it('全未知时显示未知，而不是 0', () => {
    const unknownAll = DOMESTIC.map(account => ({
      ...account,
      credits: undefined,
      creditsError: '读不到',
    }))
    const view = domesticView(unknownAll)
    expect(view.balance.known).toBe(0)
    expect(view.balance.measured).toBe(0)
    expect(balanceDisplay(view.balance)).toEqual({ kind: 'unknown' })
  })

  /** 上游没给 total 时用礼包之和 —— 那些礼包就是这笔钱，不是编出来的。 */
  it('没有 credits.total 时用礼包剩余之和', () => {
    const fromPackages = [
      poolAccount({
        id: 'P1',
        credits: {
          packages: [
            { packageName: 'monthly', remain: 120 },
            { packageName: 'bonus', remain: 80 },
          ],
        },
      }),
    ]
    const view = domesticView(fromPackages)
    expect(view.rows[0]?.balance).toBe(200)
  })
})

/**
 * 国内渠道包 X 合计 900 必须被排除。
 *
 * 这是 F2 的原貌：账号列表已经读池（4 个），余额却还在读 pack（A + X = 900）。
 * 两条断言合起来把那个数字彻底钉死 —— 视图里既不该出现 900，也不该出现 X 这个账号。
 */
describe('渠道包那份错源数据不能进池视图', () => {
  const PACK_SNAPSHOT = {
    accounts: [
      { id: 'A', label: '账号 A' },
      { id: 'X', label: '渠道包账号 X' },
    ],
    balances: [
      { accountId: 'A', balance: 400 },
      { accountId: 'X', balance: 500 },
    ],
    statuses: [],
  }

  it('池视图的余额与账号都只来自池，900 与 X 都不出现', () => {
    const view = domesticView()
    expect(view.balance.known).toBe(600)
    expect(view.balance.known).not.toBe(900)
    expect(view.rows.map(row => row.id)).toEqual(['A', 'B', 'C', 'D'])
    expect(view.rows.some(row => row.id === 'X')).toBe(false)
  })

  it('同一份 pack 数据只在 pack 自己的视图里算，得 900 与 2 个账号', () => {
    const view = buildChannelView({ channelId: 'buddy', snapshot: PACK_SNAPSHOT, state: 'ready' })
    expect(view.total).toBe(2)
    expect(view.balance.known).toBe(900)
    // 两个来源各自自洽，混起来才出错 —— 所以来源必须是显式决定，不能靠"哪个有数据用哪个"。
    expect(view.source).toEqual({ kind: 'channel', channelId: 'buddy' })
  })

  it('buddy / workbuddy 归池管时一律读池，哪怕前端还没拿到快照', () => {
    const resolution = resolveAccountSource({ id: 'buddy', ownedByPool: true })
    expect(resolution.ok).toBe(true)
    expect(resolution.ok ? resolution.source : undefined).toEqual({
      kind: 'pool',
      region: 'cn',
      channelId: 'buddy',
    })
  })

  it('旧版响应缺 ownedByPool 时两个已知渠道仍按区域映射读池', () => {
    expect(poolRegionOf('buddy')).toBe('cn')
    expect(poolRegionOf('workbuddy')).toBe('global')
    const legacy = resolveAccountSource({ id: 'workbuddy' })
    expect(legacy.ok ? legacy.source : undefined).toEqual({
      kind: 'pool',
      region: 'global',
      channelId: 'workbuddy',
    })
  })

  it('第三方渠道读自己的 pack 数据', () => {
    const resolution = resolveAccountSource({ id: 'trae', ownedByPool: false })
    expect(resolution.ok ? resolution.source : undefined).toEqual({ kind: 'channel', channelId: 'trae' })
  })

  /** 后端说归池管、前端却不认得这个渠道 —— 必须说出来，不能猜一个区域。 */
  it('池归属渠道不在已知映射里时给出诊断而不是猜', () => {
    const resolution = resolveAccountSource({ id: 'newpool', ownedByPool: true })
    expect(resolution.ok).toBe(false)
    expect(resolution.ok ? '' : resolution.problem).toContain('newpool')
  })
})

/**
 * 国际池 G：切换后显示 G，国内迟到响应不能覆盖国际视图。
 *
 * 后者是代次守卫的靶心。两个区域各有自己的号，所以它们不会互相覆盖账号；真正会出错的是
 * **同一个区域**的两次刷新乱序 —— 以及「国内迟到的响应被写进国际那一格」。
 */
describe('国际池与跨区域隔离', () => {
  const GLOBAL_POOL: readonly PoolWebAccount[] = [
    poolAccount({
      id: 'G',
      label: '账号 G',
      domain: 'www.workbuddy.ai',
      credits: { total: 888, packages: [] },
      checkin: {
        active: true,
        todayCheckedIn: true,
        streakDays: 1,
        dailyCredit: 5,
        todayCredit: 5,
        isStreakDay: false,
        nextStreakDay: 2,
        streakBonusCredit: 0,
      },
    }),
  ]

  it('国际视图只有 G，数字来自 G 自己', () => {
    const view = buildPoolView({
      channelId: 'workbuddy',
      region: 'global',
      status: { accounts: GLOBAL_POOL },
      state: 'ready',
    })
    expect(view.rows.map(row => row.id)).toEqual(['G'])
    expect(view.total).toBe(1)
    expect(view.balance.known).toBe(888)
    expect(view.checkin.checked).toBe(1)
    expect(view.source).toEqual({ kind: 'pool', region: 'global', channelId: 'workbuddy' })
  })

  it('两区各自建视图，互不污染', () => {
    const cn = domesticView()
    const global = buildPoolView({
      channelId: 'workbuddy',
      region: 'global',
      status: { accounts: GLOBAL_POOL },
      state: 'ready',
    })
    expect(cn.balance.known).toBe(600)
    expect(global.balance.known).toBe(888)
    expect(cn.rows.some(row => row.id === 'G')).toBe(false)
    expect(global.rows.some(row => row.id === 'A')).toBe(false)
  })

  it('同区域两次刷新逆序：先发后回的那次被丢掉', () => {
    const gate = createRegionGate()
    const slow = gate.issue('cn')   // 先发
    const fast = gate.issue('global') // 另一个区域，互不相关
    const newer = gate.issue('cn')  // 后发

    // 后发的先回，落地。
    expect(gate.accept('cn', newer)).toBe(true)
    // 先发的后回，不能把新数据盖回旧数据。
    expect(gate.accept('cn', slow)).toBe(false)
    // 国际那个号不受影响。
    expect(gate.accept('global', fast)).toBe(true)
  })

  it('同代次重放同一个号仍然是允许的（幂等回读）', () => {
    const gate = createRegionGate()
    const ticket = gate.issue('cn')
    expect(gate.accept('cn', ticket)).toBe(true)
    // 同一个响应被处理两次（例如重渲染触发）不该被误判为过期。
    expect(gate.accept('cn', ticket)).toBe(true)
  })

  it('区域之间用各自的号，一个区域的进度不影响另一个', () => {
    const gate = createRegionGate()
    const early = gate.issue('global')
    for (let i = 0; i < 5; i += 1) gate.issue('cn')
    // 国际那个早号还没回，但它的区域没有任何更新的号，所以仍然有效。
    expect(gate.accept('global', early)).toBe(true)
  })
})

/**
 * 渠道包的三态签到：明确 true / 明确 false / 缺失。
 *
 * 旧代码（`creditStatusesFrom`）只保留 `todayCheckedIn === true`，于是「问到了、没签」
 * 和「根本没问到」在界面上长得一样。这里先在视图层把三态分开，F4 再去修解析层。
 */
describe('渠道包签到三态', () => {
  const snapshot = {
    accounts: [
      { id: 'p1', label: 'P1' },
      { id: 'p2', label: 'P2' },
      { id: 'p3', label: 'P3' },
    ],
    balances: [
      { accountId: 'p1', balance: 10 },
      { accountId: 'p2', balance: 20 },
      { accountId: 'p3', balance: 30 },
    ],
    statuses: [
      { accountId: 'p1', todayCheckedIn: true, todayCredit: 5 },
      { accountId: 'p2', todayCheckedIn: false },
      // p3 没有状态行 -> 未知
    ],
  }

  it('true 计入已签、false 计入未签、缺失计入未知', () => {
    const view = buildChannelView({ channelId: 'p', snapshot, state: 'ready' })
    expect(view.checkin.checked).toBe(1)
    expect(view.checkin.unchecked).toBe(1)
    expect(view.checkin.unknown).toBe(1)
    expect(view.checkin.denominator).toBe(3)
    expect(view.checkin.allDone).toBe(false)
  })

  it('只有 true 拿到 todayCredit，false 与未知都不算收入', () => {
    const view = buildChannelView({ channelId: 'p', snapshot, state: 'ready' })
    expect(view.checkin.todayCredit).toBe(5)
    expect(view.rows.find(row => row.id === 'p2')?.todayCredit).toBeUndefined()
  })

  it('余额读失败的账号仍在列表里，只是余额未知', () => {
    const withFailure = {
      ...snapshot,
      balances: [
        { accountId: 'p1', balance: undefined, error: 'RPC 失败' },
        { accountId: 'p2', balance: 20 },
      ],
    }
    const view = buildChannelView({ channelId: 'p', snapshot: withFailure, state: 'ready' })
    // 账号表是骨架：p1 不会因为余额读失败而消失。
    expect(view.total).toBe(3)
    expect(view.rows.find(row => row.id === 'p1')?.balance).toBeUndefined()
    expect(view.rows.find(row => row.id === 'p1')?.balanceError).toBe('RPC 失败')
    expect(view.balance.known).toBe(20)
  })
})

describe('读取状态', () => {
  it('首次快照未就绪是 loading，没有账号也没有错误', () => {
    const view = buildPoolView({ channelId: 'buddy', region: 'cn', status: undefined, state: 'loading' })
    expect(view.state).toBe('loading')
    expect(view.total).toBe(0)
    expect(view.error).toBeUndefined()
  })

  it('刷新失败时保留上次成功的快照，并标明是陈旧的', () => {
    const view = buildPoolView({
      channelId: 'buddy',
      region: 'cn',
      status: { accounts: DOMESTIC },
      state: 'error',
      stale: true,
      error: 'HTTP 502',
    })
    // 账号还在（用户可以继续看），错误单独说，陈旧单独说。
    expect(view.total).toBe(4)
    expect(view.error).toBe('HTTP 502')
    expect(view.stale).toBe(true)
  })

  it('真实空值：ready 且 0 个账号，不是加载中', () => {
    const view = buildPoolView({ channelId: 'buddy', region: 'cn', status: { accounts: [] }, state: 'ready' })
    expect(view.state).toBe('ready')
    expect(view.total).toBe(0)
    // 零账号不是"全已签"，按钮不该显示成已领取。
    expect(view.checkin.allDone).toBe(false)
  })
})

/** 行投影单独测：页面直接读 rows，不再各算一遍。 */
describe('行投影', () => {
  it('池的行带 enabled / balance / checkin 三件事', () => {
    const rows = rowsFromPool(DOMESTIC)
    expect(rows.map(row => row.id)).toEqual(['A', 'B', 'C', 'D'])
    expect(rows.map(row => row.enabled)).toEqual([true, true, false, true])
    expect(rows.map(row => row.checkin)).toEqual(['checked', 'unchecked', 'unchecked', 'unchecked'])
    expect(rows[0]?.balance).toBe(100)
    expect(rows[3]?.balance).toBeUndefined()
  })

  it('渠道包的行以账号表为骨架，余额与状态按 id 关联', () => {
    const rows = rowsFromChannel({
      accounts: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
      balances: [{ accountId: 'b', balance: 7 }],
      statuses: [],
    })
    expect(rows).toHaveLength(2)
    expect(rows[0]?.balance).toBeUndefined()
    expect(rows[1]?.balance).toBe(7)
    expect(rows.every(row => row.checkin === 'unknown')).toBe(true)
  })

  it('未知列（少了签到、少了余额）不会让整行丢失', () => {
    const view = buildAccountView({
      source: { kind: 'channel', channelId: 'x' },
      state: 'ready',
      rows: rowsFromChannel({ accounts: [{ id: 'only', label: 'Only' }], balances: [], statuses: [] }),
    })
    expect(view.total).toBe(1)
    expect(view.balance.measured).toBe(0)
    expect(view.checkin.unknown).toBe(1)
  })
})

/**
 * 页面级入口：一份视图，一个来源。
 *
 * 上面各条测的是投影本身，这一组测的是**页面不会混用数据源**。它是 F2 的直接守卫：
 * 3.2.0 的写法是「账号读池、余额读 pack」，两行代码各自都合理，混起来就是 900。
 */
describe('buildPageView 只读一个来源', () => {
  const PACK = {
    accounts: [
      { id: 'A', nickname: '账号 A' },
      { id: 'X', nickname: '渠道包账号 X' },
    ],
    balances: [
      { accountId: 'A', balance: 400 },
      { accountId: 'X', balance: 500 },
    ],
    statuses: [],
  }

  it('归池管的渠道：即使给了 pack 数据也完全不读它', () => {
    const view = buildPageView({
      channel: { id: 'buddy', ownedByPool: true },
      laneAccounts: DOMESTIC,
      pack: PACK,
      state: 'ready',
    })
    // 池的四个账号，与 pack 的两个无关。
    expect(view.rows.map(row => row.id)).toEqual(['A', 'B', 'C', 'D'])
    expect(view.balance.known).toBe(600)
    // 900 在任何形式下都不该出现。
    expect(view.balance.known).not.toBe(900)
    expect(view.total).not.toBe(2)
  })

  it('第三方渠道：读 pack，池数据缺席也不影响', () => {
    const view = buildPageView({
      channel: { id: 'trae', ownedByPool: false },
      pack: PACK,
      state: 'ready',
    })
    expect(view.total).toBe(2)
    expect(view.balance.known).toBe(900)
    expect(view.source).toEqual({ kind: 'channel', channelId: 'trae' })
  })

  /**
   * 池来源但 lane 还没到：加载态，**不退回 pack**。
   *
   * 退回 pack 会让页面在加载过程中短暂显示另一批账号和另一个余额，这正是用户报的那个
   * "刷新一下数字就变了"。宁可空着。
   */
  it('池来源但还没有 lane 时是加载态，不退回 pack', () => {
    const view = buildPageView({
      channel: { id: 'buddy', ownedByPool: true },
      laneAccounts: undefined,
      pack: PACK,
      state: 'ready',
    })
    expect(view.state).toBe('loading')
    expect(view.total).toBe(0)
    expect(view.balance.known).toBe(0)
    // 来源仍然是池 —— 来源不随数据是否到货而变。
    expect(view.source).toEqual({ kind: 'pool', region: 'cn', channelId: 'buddy' })
  })

  it('pool 归属但渠道不认识：错误视图，两份数据都不读', () => {
    const view = buildPageView({
      channel: { id: 'mystery', ownedByPool: true },
      laneAccounts: DOMESTIC,
      pack: PACK,
      state: 'ready',
    })
    expect(view.state).toBe('error')
    expect(view.total).toBe(0)
    expect(view.error).toContain('mystery')
  })
})
