/**
 * 一个渠道的「账号视图」：谁在列表里、多少积分、今天签了没有。
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * 同一个页面有两份账号数据能用，而它们**不是同一批账号**：
 *
 *   - 插件自己的池（`PoolWebStatus.accounts`），buddy / workbuddy 两条 lane 的账号在这里；
 *   - 渠道包自己的账号表（`account.list` 的 balances / statuses），其余渠道在这里。
 *
 * 3.2.0 把「账号列表」换成了池，却把「余额合计」和「批量领取」留在了渠道包上。于是国内页
 * 显示池里的 4 个账号、余额却是 pack 那 2 个账号的 900 —— 两个数字各自都是真的，只是描述的
 * 不是同一批账号。用户无法从界面上看出这件事，只能得出「余额算错了」。
 *
 * 所以这里把「用哪一份数据」变成一个**显式决定**（`resolveAccountSource`），再让所有数字
 * 从那个决定投影出来（`buildAccountView`）。一个视图只读一份源，混不了。
 *
 * 口径（交接文档 4.2，逐条对应下面的实现）：
 *   - 账号数 = 列表行数；启用数另行标注
 *   - 余额 = 列表里**全部**账号的有效余额求和，停用账号仍计入（它还是我的钱）
 *   - 缺失与错误算未知，零算有效；部分未知要给出覆盖数，好让「已知小计」不被误读成总额
 *   - 签到以**启用账号**为分母：明确 true 计入已签、明确 false 计入未签、缺失或报错算未知
 *   - 渠道级钱包（pack 的聚合总额）保持渠道级语义，不摊到账号头上伪造逐号余额
 *
 * @module dsh-xdpool/client/account-view
 */

import type { PoolRegion, PoolWebAccount } from '../status-paths.ts'

/** 这一页的账号数据来自哪里。 */
export type AccountSource =
  | {
    readonly kind: 'pool'
    readonly region: PoolRegion
    readonly channelId: string
  }
  | {
    readonly kind: 'channel'
    readonly channelId: string
  }

/** 读取状态。`stale` 与它正交：沿用上次成功快照时 state 仍是 ready。 */
export type ReadState = 'loading' | 'ready' | 'error'

/** 一个账号今天的签到处境。三态，未知必须能与「未签」区分开。 */
export type CheckinState = 'checked' | 'unchecked' | 'unknown'

/** 投影后的一行账号。页面只读这个，不再分别去读池和 pack。 */
export interface AccountRow {
  readonly id: string
  readonly label: string
  /** 用户手动关掉的账号。仍在列表里，也仍在余额合计里。 */
  readonly enabled: boolean
  /** 有效余额；`undefined` 表示未知（缺失或读取失败），不是 0。 */
  readonly balance: number | undefined
  readonly checkin: CheckinState
  /** 今天签到到账的积分，只有在 `checkin === 'checked'` 且有数值时才有。 */
  readonly todayCredit: number | undefined
  /** 余额为什么读不到，用于行内提示。 */
  readonly balanceError: string | undefined
  /** 签到为什么读不到。 */
  readonly checkinError: string | undefined
  /**
   * 上游是否开着签到活动。
   *
   * 单独一格而不是塞进 `checkin`：「今天没签」和「这个活动已经结束」是两件事，
   * 后者不该进批量领取的目标表，也不该被当成「未签」去统计。声明成
   * `boolean | undefined` 是因为没有签到数据时这一格也读不到 —— 未知就是未知。
   */
  readonly activityActive: boolean | undefined
}

/** 余额的汇总结果，区分「小计」与「覆盖」两件事。 */
export interface BalanceSummary {
  /** 已知余额之和。全部未知时为 0，与真正的 0 余额靠 `measured` 区分。 */
  readonly known: number
  /** 有有效余额的账号数。 */
  readonly measured: number
  /** 列表里的账号数，也就是分母。 */
  readonly total: number
  /** 每个账号都有有效余额。 */
  readonly complete: boolean
}

/** 签到的汇总结果。 */
export interface CheckinSummary {
  readonly checked: number
  readonly unchecked: number
  readonly unknown: number
  /** 分母：启用的账号数。停用账号不参与签到统计。 */
  readonly denominator: number
  /** 已签账号今天到账的积分之和。 */
  readonly todayCredit: number
  /** 全部启用账号都已明确签到 —— 此时按钮该说「今日已领取」。 */
  readonly allDone: boolean
}

/** 一个渠道的完整账号视图。 */
export interface AccountView {
  readonly source: AccountSource
  readonly state: ReadState
  /** 这份数据是上次成功读到的，本次刷新失败或还没回来。 */
  readonly stale: boolean
  readonly error: string | undefined
  readonly rows: readonly AccountRow[]
  readonly total: number
  readonly enabled: number
  readonly balance: BalanceSummary
  readonly checkin: CheckinSummary
}

/**
 * 一个区域对应的渠道 id。
 *
 * 与 `region-card.tsx` 的 `REGION_CHANNEL_BY_REGION` 同一组映射，但方向相反：那里是
 * 「这条 lane 长什么样」，这里是「这个渠道的账号归哪个区域」。抄一份反向表比在渲染层
 * 反复 `Object.entries().find()` 更不容易出错 —— 后者在没有匹配时返回 undefined，
 * 而「没有匹配」在这里是必须被说出来的异常。
 */
const REGION_OF_CHANNEL: Readonly<Record<string, PoolRegion>> = Object.freeze({
  buddy: 'cn',
  workbuddy: 'global',
})

/** 一个渠道的账号归插件池管时，它属于哪个区域。 */
export function poolRegionOf(channelId: string): PoolRegion | undefined {
  return REGION_OF_CHANNEL[channelId]
}

/** 反查结果：一个明确的来源，或者一个需要告诉用户的诊断。 */
export type SourceResolution =
  | { readonly ok: true; readonly source: AccountSource }
  | { readonly ok: false; readonly problem: string }

/**
 * 这个渠道的账号该从哪一份数据读。
 *
 * `ownedByPool` 是后端给你的答案（`POOL_OWNED_CHANNELS`），所以它说「归池管」就必须读池，
 * 不能因为前端还没拿到 lane 就退回去读 pack —— 那正是 900 那个数字的来路。反过来，后端说
 * 不归池管就一律读 pack，哪怕这个渠道 id 恰好在反向表里（旧版响应可能不给 ownedByPool，
 * 那两个已知渠道仍按映射兼容）。
 *
 * 只做「读哪一份」的决定，不碰数据：池快照还没回来时调用方照样得到池来源，配一个 loading
 * 状态即可。让来源随快照是否到货而变化，会让页面在加载过程中短暂显示另一批账号。
 */
export function resolveAccountSource(
  channel: { readonly id: string; readonly ownedByPool?: boolean | undefined },
): SourceResolution {
  const owned = channel.ownedByPool === true
  const region = poolRegionOf(channel.id)
  if (!owned && region === undefined) {
    return { ok: true, source: { kind: 'channel', channelId: channel.id } }
  }
  if (region === undefined) {
    /*
      `ownedByPool` 说归池管，但反向表里没有这个渠道 —— 后端的池归属和前端认得的区域对不上。
      这时读任何一份数据都会给出错的账号，所以返回诊断而不是猜一个区域。
    */
    return {
      ok: false,
      problem: `渠道 ${channel.id} 归账号池管，但界面不认识它的区域，账号统计已停用`,
    }
  }
  return { ok: true, source: { kind: 'pool', region, channelId: channel.id } }
}

/** 一个数字能不能当余额用：有限数值才算，NaN / Infinity 都是读坏了。 */
function usableAmount(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined
}

/**
 * 池账号 → 行。
 *
 * 余额优先读 `credits.total`（上游给的聚合值），没有时退回 `packages` 之和 —— 后者不是
 * 虚构：那些礼包就是这笔钱本身，只是上游没给总数。`creditsError` 一律算未知，因为一个
 * 报错的账号可能仍有余额，把报错当 0 会低报。
 */
export function rowsFromPool(accounts: readonly PoolWebAccount[]): AccountRow[] {
  return accounts.map(account => {
    const total = usableAmount(account.credits?.total)
    const packages = account.credits?.packages ?? []
    let fromPackages: number | undefined
    for (const entry of packages) {
      const remain = usableAmount(entry.remain)
      if (remain === undefined) continue
      fromPackages = (fromPackages ?? 0) + remain
    }
    const errored = account.creditsError !== undefined
    const balance = errored ? undefined : (total ?? fromPackages)

    const checkinError = account.checkinError
    const checkin: CheckinState = checkinError !== undefined || account.checkin === undefined
      ? 'unknown'
      : account.checkin.todayCheckedIn
        ? 'checked'
        : 'unchecked'
    const todayCredit = checkin === 'checked'
      ? usableAmount(account.checkin?.todayCredit)
      : undefined

    return {
      id: account.id,
      label: account.label,
      enabled: account.disabled !== true,
      balance,
      checkin,
      todayCredit,
      balanceError: account.creditsError,
      checkinError,
      activityActive: account.checkin === undefined ? undefined : account.checkin.active,
    }
  })
}

/** 渠道包里一个账号的余额行，字段已归一化成数字。 */
export interface ChannelBalanceRow {
  readonly accountId: string
  /** 归一化后的余额；调用方负责把供应商的各种形状读成数字。 */
  readonly balance: number | undefined
  readonly error?: string | undefined
}

/** 渠道包里一个账号的签到行。`todayCheckedIn` 三态：true / false / 缺失。 */
export interface ChannelStatusRow {
  readonly accountId: string
  readonly todayCheckedIn?: boolean | undefined
  readonly todayCredit?: number | undefined
}

/** 渠道包的账号表。三份数据按 `accountId` 关联。 */
export interface ChannelSnapshot {
  readonly accounts: readonly {
    readonly id: string
    /** 显示名。pack 的行只有 `nickname`，所以它可能是空的。 */
    readonly nickname?: string | undefined
    readonly name?: string | undefined
    readonly disabled?: boolean | undefined
    readonly enabled?: boolean | undefined
  }[]
  readonly balances: readonly ChannelBalanceRow[]
  readonly statuses: readonly ChannelStatusRow[]
  /**
   * `credits.status` 这个 RPC 自己失败的原因。
   *
   * 交接文档 4.4：「RPC 失败的外层状态也必须传到视图」。没有这一格的时候，
   * 一次失败的 status 调用与"这个渠道没有签到"在视图里完全一样（都是空数组），
   * 于是每个账号都被算成未知、理由却是空白。
   */
  readonly statusError?: string | undefined
}

/**
 * 渠道包快照 → 行。
 *
 * 账号表是骨架：余额和签到都按 id 关联，关联不上就是未知。不能倒过来用余额表当骨架 ——
 * 一个账号余额读失败时余额表里可能根本没有它，那样这个账号会从列表里消失，用户看到的是
 * 「账号少了」，而事实是「余额没读到」。
 */
export function rowsFromChannel(snapshot: ChannelSnapshot): AccountRow[] {
  const balanceOf = new Map<string, ChannelBalanceRow>()
  for (const row of snapshot.balances) balanceOf.set(row.accountId, row)
  const statusOf = new Map<string, ChannelStatusRow>()
  for (const row of snapshot.statuses) statusOf.set(row.accountId, row)

  return snapshot.accounts.map(account => {
    const balanceRow = balanceOf.get(account.id)
    const statusRow = statusOf.get(account.id)
    const balance = balanceRow?.error === undefined
      ? usableAmount(balanceRow?.balance)
      : undefined
    // 明确 false 是「问到了、没签」，缺失才是未知。丢掉 false 会让未签账号看起来像未知。
    const checkin: CheckinState = statusRow?.todayCheckedIn === true
      ? 'checked'
      : statusRow?.todayCheckedIn === false ? 'unchecked' : 'unknown'
    const todayCredit = checkin === 'checked' ? usableAmount(statusRow?.todayCredit) : undefined
    /*
      pack 的行用 `enabled`，池的行用 `disabled` —— 两种极性。这里统一成 enabled，
      并且**缺字段算启用**：一个没说"我关掉了"的账号默认是在用的，反过来会让老响应里
      的账号全都变成停用。
    */
    const enabled = account.disabled === true
      ? false
      : account.enabled !== false
    /*
      整次 status 读取失败时，每个账号的签到都是"问不到"而不是"没签"。
      理由要带出去，否则界面只能画一个不知道从哪来的未知。
    */
    const checkinError = snapshot.statusError
    return {
      id: account.id,
      label: account.nickname ?? account.name ?? account.id,
      enabled,
      balance,
      checkin: checkinError === undefined ? checkin : 'unknown',
      todayCredit: checkinError === undefined ? todayCredit : undefined,
      balanceError: balanceRow?.error,
      checkinError,
      /*
        渠道包的状态行没有「活动是否开着」这一格。缺它就是未知，不能当 true ——
        `active: false` 会让批量跳过，凭空补一个 true 会替上游做决定。
      */
      activityActive: undefined,
    }
  })
}

/**
 * 汇总一批行。
 *
 * 这是 4.2 那张表的唯一实现处。所有数字都从同一批行算出来，所以「账号 4 / 启用 3 /
 * 已签 1/3 / 余额 600 覆盖 3/4」必然自洽 —— 它们不可能是四个各自读取时点的快照。
 */
export function buildAccountView(input: {
  readonly source: AccountSource
  readonly state: ReadState
  readonly stale?: boolean | undefined
  readonly error?: string | undefined
  readonly rows: readonly AccountRow[]
}): AccountView {
  const { rows } = input
  let known = 0
  let measured = 0
  let enabled = 0
  let checked = 0
  let unchecked = 0
  let unknown = 0
  let todayCredit = 0

  for (const row of rows) {
    if (row.balance !== undefined) {
      known += row.balance
      measured += 1
    }
    if (!row.enabled) continue
    enabled += 1
    if (row.checkin === 'checked') {
      checked += 1
      todayCredit += row.todayCredit ?? 0
    } else if (row.checkin === 'unchecked') {
      unchecked += 1
    } else {
      unknown += 1
    }
  }

  return {
    source: input.source,
    state: input.state,
    stale: input.stale === true,
    error: input.error,
    rows,
    total: rows.length,
    enabled,
    balance: {
      known,
      measured,
      total: rows.length,
      complete: rows.length > 0 && measured === rows.length,
    },
    checkin: {
      checked,
      unchecked,
      unknown,
      denominator: enabled,
      todayCredit,
      /*
        全已签才把按钮变成「今日已领取」。未知不算完成 —— 一个账号状态没读到并不等于它签过，
        按「已签」处理会让用户永久失去领取机会（按钮再也不亮）。
      */
      allDone: enabled > 0 && checked === enabled,
    },
  }
}

/** 池快照 → 视图。缺失快照就是加载态，没有数据可说。 */
export function buildPoolView(input: {
  readonly channelId: string
  readonly region: PoolRegion
  readonly status: { readonly accounts: readonly PoolWebAccount[] } | undefined
  readonly state: ReadState
  readonly stale?: boolean | undefined
  readonly error?: string | undefined
}): AccountView {
  const rows = input.status === undefined ? [] : rowsFromPool(input.status.accounts)
  return buildAccountView({
    source: { kind: 'pool', region: input.region, channelId: input.channelId },
    state: input.state,
    stale: input.stale,
    error: input.error,
    rows,
  })
}

/** 渠道包快照 → 视图。 */
export function buildChannelView(input: {
  readonly channelId: string
  readonly snapshot: ChannelSnapshot | undefined
  readonly state: ReadState
  readonly stale?: boolean | undefined
  readonly error?: string | undefined
}): AccountView {
  const rows = input.snapshot === undefined ? [] : rowsFromChannel(input.snapshot)
  return buildAccountView({
    source: { kind: 'channel', channelId: input.channelId },
    state: input.state,
    stale: input.stale,
    error: input.error,
    rows,
  })
}

/**
 * 一个渠道详情页要显示的那一份视图 —— 页面只调这一个函数。
 *
 * 为什么要有一个「页面级」入口而不是让页面自己挑：3.2.0 的 bug 正是"账号读这份、余额读
 * 那份"拼出来的，而那种错误在渲染代码里看不出来（两行都合理，只是来源不同）。把选择
 * 收进一个函数后，混用不再可能 —— 这个函数只返回一份来源的投影，`inputs` 里同时给出两份
 * 数据也不会让它们相遇。
 *
 * `pack` 是渠道包的快照。它**只在来源是渠道时才被读取**；池来源下它连碰都不碰，所以国内容
 * 那个 900 进不了这个视图。这条不是靠调用方自律，而是靠这里的分支。
 */
export function buildPageView(inputs: {
  readonly channel: {
    readonly id: string
    readonly ownedByPool?: boolean | undefined
  }
  /** 插件池给这条 lane 的账号；没有 lane 时为 undefined。 */
  readonly laneAccounts?: readonly PoolWebAccount[] | undefined
  /** 渠道包的三份数据。池来源下会被忽略。 */
  readonly pack?: ChannelSnapshot | undefined
  /** 渠道包余额读取失败的原因。 */
  readonly packError?: string | undefined
  readonly state: ReadState
  readonly error?: string | undefined
}): AccountView {
  const resolved = resolveAccountSource(inputs.channel)
  if (!resolved.ok) {
    return buildAccountView({
      source: { kind: 'channel', channelId: inputs.channel.id },
      state: 'error',
      error: resolved.problem,
      rows: [],
    })
  }
  if (resolved.source.kind === 'pool') {
    /*
      池来源下 lane 缺席按加载态处理，**不退回 pack**。退回 pack 就是"账号读池、余额读 pack"
      那个 bug 的一半，而且看起来完全正常 —— 页面上有数字，只是那些数字属于另一批账号。
    */
    return buildPoolView({
      channelId: inputs.channel.id,
      region: resolved.source.region,
      status: inputs.laneAccounts === undefined ? undefined : { accounts: inputs.laneAccounts },
      state: inputs.laneAccounts === undefined ? 'loading' : inputs.state,
      error: inputs.error,
    })
  }
  return buildChannelView({
    channelId: inputs.channel.id,
    snapshot: inputs.pack,
    state: inputs.state,
    error: inputs.error ?? inputs.packError,
  })
}

/**
 * 余额该怎么显示。
 *
 * 三种情况必须给三种答案：读到一部分要说「已知」并给出覆盖数，一个都没读到要说未知，
 * 全读到才是总和。把部分未知显示成总和是本模块存在的主要原因 —— 600 看起来像一个
 * 确定的数字，实际上第四个账号的余额还没读到。
 */
export type BalanceDisplay =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'partial'; readonly known: number; readonly measured: number; readonly total: number }
  | { readonly kind: 'complete'; readonly known: number }

export function balanceDisplay(summary: BalanceSummary): BalanceDisplay {
  if (summary.total === 0 || summary.measured === 0) return { kind: 'unknown' }
  if (summary.complete) return { kind: 'complete', known: summary.known }
  return {
    kind: 'partial',
    known: summary.known,
    measured: summary.measured,
    total: summary.total,
  }
}

/**
 * 区域快照的代次守卫。
 *
 * 同一个区域会被反复刷新：定时轮询、按钮回读、切换区域后的补读。请求**不保证按发出顺序
 * 返回**，慢的那一个后到就会把新数据盖成旧数据 —— 用户看到的是「刚点完签到，数字又变回去」。
 *
 * 这里给每个区域一个自增号，只有号不小于已应用号的响应才准落地。号在**发出请求时**取，
 * 所以后发的永远更大；先发但晚回的那个自然被丢掉。
 */
export interface RegionGate {
  /** 取一个号，发请求前调用。 */
  issue(region: PoolRegion): number
  /** 这个响应还该不该落地。 */
  accept(region: PoolRegion, ticket: number): boolean
}

export function createRegionGate(): RegionGate {
  const latest = new Map<PoolRegion, number>()
  let counter = 0
  return {
    issue(region) {
      counter += 1
      return counter
    },
    accept(region, ticket) {
      const current = latest.get(region)
      if (current !== undefined && ticket < current) return false
      latest.set(region, ticket)
      return true
    },
  }
}
