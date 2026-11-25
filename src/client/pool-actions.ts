/**
 * 池动作的纯逻辑：谁能被批量领取、每一次点击落到哪些账号、结果怎么记。
 *
 * 放在这里而不是组件里，是因为这些判断是可验证的句子 ——「停用的账号不领」「已签
 * 的不重交」「未知的先复查」—— 混在 JSX 和 fetch 里就只能靠肉眼读。组件只负责
 * 把这里算好的 ID 序列按顺序发出去。
 *
 * 见交接文档 4.3「池动作契约」。
 */
import type { AccountRow } from './account-view.ts'

/**
 * 一次单号动作的结局。
 *
 * 四态而不是「成功/失败」两态，因为界面要说的不是「成功」：
 * - `claimed` 真的领到了（带 credit）。
 * - `alreadyClaimed` 上游说今天已经领过 —— 这不是错误，也不该重试。
 * - `skipped` 我们自己决定不发请求（活动关闭、账号停用、状态复核后仍未知）。
 * - `failed` 发了但没成。
 *
 * 交接文档 4.3 要求结果语义为 `accountId + outcome + credit? + error?`，
 * 并且「写入后的 refresh 结果单独记录」—— 所以回读失败不是 `failed`，是
 * `refreshFailed`，因为它不改变「领到了没有」这个事实。
 */
export type PoolActionOutcome = 'claimed' | 'alreadyClaimed' | 'skipped' | 'failed'

/** 一个账号的结果，外加它为什么是这个结果（人话）。 */
export interface PoolActionResult {
  readonly accountId: string
  /** 点下去那一刻界面上的标签，用于结果里说「B 失败」而不是显示一串 id。 */
  readonly label: string
  readonly outcome: PoolActionOutcome
  /** 只有 `claimed` 且上游报了数字时才有。 */
  readonly credit?: number | undefined
  /** 失败或跳过的人话原因。 */
  readonly error?: string | undefined
}

/**
 * 一批动作的完整记录。
 *
 * `refresh` 与 `results` 分开，是因为交接文档明确要求：领取成功但回读超时时，
 * 界面得说「已领取，状态待刷新」—— 把回读失败混进 `results` 会让已经到手的
 * 积分显示成没领到，用户于是再点一次。
 *
 * `skipped` 单独一栏，放那些「复查后仍然定不下来」的账号。它们不是失败
 * （我们没发请求），也不该混进结果里让「已领取 N」这个数字失真。
 */
export interface PoolBatchReport {
  readonly results: readonly PoolActionResult[]
  readonly skipped: readonly PoolActionResult[]
  /** 批次结束后统一回读的结果；`claimed` 表示成功。 */
  readonly refresh: { readonly ok: boolean; readonly error?: string | undefined }
}

/** 批量目标的选择理由，用于向用户解释跳过。 */
export type PoolSkipReason = 'disabled' | 'activityClosed' | 'unknownStatus' | 'alreadyChecked'

export const SKIP_REASON_TEXT: Readonly<Record<PoolSkipReason, string>> = Object.freeze({
  disabled: '账号已停用',
  activityClosed: '签到活动未开启',
  unknownStatus: '签到状态未知，跳过（可先「重新检测」再试）',
  alreadyChecked: '今天已经签到',
})

/**
 * 一个账号能不能进批量目标表。
 *
 * 判据顺序是有意的，且每条都对应一次真实误提交：
 * 1. **停用** —— 用户关掉这个账号就是不想让它被用，替它签到是违背这个决定。
 * 2. **活动关闭** —— 上游 `active: false` 时请求必然白跑。
 * 3. **状态未知** —— 交接文档要求「未知先复查，仍未知则跳过并解释」。复查由
 *    调用方做（它会重新读一次状态再问一遍），这里只回答「现在这一份数据里能不能定」。
 * 4. **已签** —— 也算不进目标表：重复点击不该重复发请求。
 */
export type BatchEligibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: PoolSkipReason }

export function batchEligibility(row: AccountRow): BatchEligibility {
  if (!row.enabled) return { ok: false, reason: 'disabled' }
  if (row.activityActive === false) return { ok: false, reason: 'activityClosed' }
  if (row.checkin === 'unknown') return { ok: false, reason: 'unknownStatus' }
  if (row.checkin === 'checked') return { ok: false, reason: 'alreadyChecked' }
  return { ok: true }
}

/**
 * 「全部领取」这一刻要提交的账号，按界面上的顺序。
 *
 * 只返回明确「启用 + 活动开着 + 明确未签」的那些。用第 6 节夹具说：A 已签、
 * C 停用、X 属于渠道包不是池账号、G 属于另一个区域 —— 四者都不在结果里，
 * 只剩 B 和 D。
 */
export function batchTargets(rows: readonly AccountRow[]): AccountRow[] {
  return rows.filter(row => batchEligibility(row).ok)
}

/**
 * 把「现在能定的目标」和「得先复查的账号」分开。
 *
 * 交接文档 4.3：批量签到「未知状态先重查，仍未知则记录跳过」。所以
 * 「现在算不出来」不等于「不领」—— 它只是要先再问一次上游。这个函数只负责
 * 分栏，复查本身由调用方做（它才知道怎么读一次新鲜状态）。
 */
export interface BatchPlan {
  /** 现在就能提交的。 */
  readonly ready: readonly AccountRow[]
  /** 状态未知，值得先复查一遍的。 */
  readonly recheck: readonly AccountRow[]
  /** 复查也救不了的（停用、活动关闭、已签），附原因。 */
  readonly skipped: readonly { readonly row: AccountRow; readonly reason: PoolSkipReason }[]
}

export function planBatch(rows: readonly AccountRow[]): BatchPlan {
  const ready: AccountRow[] = []
  const recheck: AccountRow[] = []
  const skipped: { row: AccountRow; reason: PoolSkipReason }[] = []
  for (const row of rows) {
    const verdict = batchEligibility(row)
    if (verdict.ok) { ready.push(row); continue }
    if (verdict.reason === 'unknownStatus') { recheck.push(row); continue }
    skipped.push({ row, reason: verdict.reason })
  }
  return { ready, recheck, skipped }
}

/**
 * 把一批目标按序执行，每次一个。
 *
 * 顺序而非并发：交接文档 4.3 明确写「批量按序调用现有单号服务即可，避免新增
 * 并发调度层」。上游的签到接口带有「先查后领」的逻辑，并发打过去只会让两边
 * 都看到「还没领」然后各领一次。
 *
 * `run` 抛出的异常被收成 `failed` —— 一个账号的意外不能让后面五个人不领。
 * `signal.aborted` 时不开始新的账号，但已经在飞的那个会跑完并记结果：它已经
 * 发出去了，丢掉它的结果只会让用户以为没领到。
 */
export interface RunBatchOptions {
  readonly run: (accountId: string) => Promise<Omit<PoolActionResult, 'accountId' | 'label'>>
  readonly signal?: AbortSignal | undefined
  /** 每个账号出结果就通知一次（用于逐行显示进度）。 */
  readonly onResult?: ((result: PoolActionResult) => void) | undefined
}

export async function runBatch(
  targets: readonly AccountRow[],
  options: RunBatchOptions,
): Promise<readonly PoolActionResult[]> {
  const results: PoolActionResult[] = []
  for (const row of targets) {
    if (options.signal?.aborted === true) break
    let result: PoolActionResult
    try {
      const said = await options.run(row.id)
      result = { accountId: row.id, label: row.label, ...said }
    } catch (cause: unknown) {
      result = {
        accountId: row.id,
        label: row.label,
        outcome: 'failed',
        error: cause instanceof Error ? cause.message : String(cause),
      }
    }
    results.push(result)
    options.onResult?.(result)
  }
  return results
}

/** 一批结果里成功的数量，用于「已领取 N 个账号」。 */
export function claimedCount(results: readonly PoolActionResult[]): number {
  return results.filter(result => result.outcome === 'claimed' || result.outcome === 'alreadyClaimed').length
}

/** 一批结果里失败的数量。跳过的不算失败 —— 它不是错误。 */
export function failedCount(results: readonly PoolActionResult[]): number {
  return results.filter(result => result.outcome === 'failed').length
}

/**
 * 一次「全部领取」的完整流程。
 *
 * 顺序照交接文档 4.3 写：先定目标 → 未知的先复查 → 复查后仍未知的记跳过 →
 * 剩下的按序提交 → 批次结束统一回读。抽成一个函数而不是散在组件的事件处理里，
 * 是因为这五步的**次序**本身就是契约（先复查再提交，否则未知的会被当成可领）。
 *
 * `recheck` 由调用方提供：它要重新读一次这个账号的签到状态，返回最新的
 * `AccountRow`；读不到就返回 undefined，那个账号就留在跳过里。
 */
export interface ClaimAllOptions {
  readonly rows: readonly AccountRow[]
  /**
   * 本批次**不要**再提交的账号：已经领到、但回读失败因而界面还画着"未签"的那些。
   *
   * 这是交接文档 4.3「成功账号不会因刷新失败被立即再次提交」的落实处。
   * 服务端的「先查后领」是第二道闸，但它要求网络往返成功；用户点第二下时如果
   * 回读仍然失败，光靠它就意味着又发一次请求。所以客户端记住自己刚领到谁。
   */
  readonly skipIds?: ReadonlySet<string> | undefined
  /** 领一个账号。抛异常算失败，不会中断整批。 */
  readonly claim: (accountId: string) => Promise<Omit<PoolActionResult, 'accountId' | 'label'>>
  /** 重读一个账号的最新状态；读不到返回 undefined。 */
  readonly recheck: (accountId: string) => Promise<AccountRow | undefined>
  /** 批次结束后统一回读整个区域。 */
  readonly refresh: () => Promise<{ readonly ok: boolean; readonly error?: string | undefined }>
  readonly signal?: AbortSignal | undefined
  readonly onResult?: ((result: PoolActionResult) => void) | undefined
}

export async function claimAll(options: ClaimAllOptions): Promise<PoolBatchReport> {
  const skip = options.skipIds
  const visible = skip === undefined || skip.size === 0
    ? options.rows
    : options.rows.filter(row => !skip.has(row.id))
  const plan = planBatch(visible)
  const skipped: PoolActionResult[] = plan.skipped.map(({ row, reason }) => ({
    accountId: row.id,
    label: row.label,
    outcome: 'skipped',
    error: SKIP_REASON_TEXT[reason],
  }))

  /*
    复查这一步只对「状态未知」的账号做，而且它自己可能失败。复查失败不是错误 —
    它就是「还是不知道」，照样记跳过并说清楚该做什么。
  */
  const recovered: AccountRow[] = []
  for (const row of plan.recheck) {
    try {
      const fresh = await options.recheck(row.id)
      const verdict = fresh === undefined ? undefined : batchEligibility(fresh)
      if (fresh !== undefined && verdict?.ok === true) {
        recovered.push(fresh)
      } else {
        skipped.push({
          accountId: row.id,
          label: row.label,
          outcome: 'skipped',
          error: fresh === undefined
            ? '签到状态复查失败，跳过（可稍后重试）'
            : SKIP_REASON_TEXT[verdict !== undefined && !verdict.ok ? verdict.reason : 'unknownStatus'],
        })
      }
    } catch (cause: unknown) {
      skipped.push({
        accountId: row.id,
        label: row.label,
        outcome: 'skipped',
        error: `签到状态复查失败（${cause instanceof Error ? cause.message : String(cause)}），跳过`,
      })
    }
  }

  const results = await runBatch([...plan.ready, ...recovered], {
    run: options.claim,
    signal: options.signal,
    ...options.onResult === undefined ? {} : { onResult: options.onResult },
  })

  let refresh: { ok: boolean; error?: string | undefined }
  try {
    refresh = await options.refresh()
  } catch (cause: unknown) {
    refresh = { ok: false, error: cause instanceof Error ? cause.message : String(cause) }
  }
  return { results, skipped, refresh }
}

/**
 * 批次结果的一句话总结，以及它该不该被当成错误报出去。
 *
 * `tone` 由调用方决定挂在哪：`ok` 走成功提示，`warn` 走警示条，`error` 才走
 * 错误条。分开是因为「3 个成功、1 个失败」不是错误 —— 把它染成红色会让用户
 * 以为整批都没成。
 */
export interface BatchSummary {
  readonly text: string
  readonly tone: 'ok' | 'warn' | 'error'
}

export function summarizeBatch(
  report: PoolBatchReport,
  labels: { readonly claimed: (n: number) => string; readonly failed: (n: number) => string },
): BatchSummary {
  const claimed = claimedCount(report.results)
  const failed = failedCount(report.results)
  const parts: string[] = []
  if (claimed > 0) parts.push(labels.claimed(claimed))
  if (failed > 0) parts.push(labels.failed(failed))
  if (report.skipped.length > 0) parts.push(`跳过 ${String(report.skipped.length)} 个`)
  /*
    回读失败单独说一句，且不改变「领到了」这个结论。交接文档 4.3：领取成功且
    刷新失败时提示已领取、状态待刷新。
  */
  if (!report.refresh.ok) {
    parts.push(`状态待刷新（${report.refresh.error ?? '回读失败'}）`)
  }
  const text = parts.length === 0 ? '没有可领取的账号' : parts.join('，')
  const tone: BatchSummary['tone'] = report.results.length === 0
    ? 'warn'
    : failed > 0 || !report.refresh.ok
      ? 'warn'
      : 'ok'
  return { text, tone }
}

/**
 * 服务端签到响应 → 结果态。
 *
 * `alreadyCheckedIn` 是基线服务端的既有语义（第二次点击时它答这个），保留它
 * 意味着「重复点击」不需要客户端猜：服务端说了算。缺响应体时按 `failed` 处理
 * 而不是乐观地当成功 —— 没读到凭据就是没读到。
 */
export function outcomeFromClaim(body: unknown, ok: boolean): {
  outcome: PoolActionOutcome
  credit?: number | undefined
  error?: string | undefined
} {
  if (!ok) {
    const message = (body as { error?: unknown } | undefined)?.error
    return { outcome: 'failed', error: typeof message === 'string' ? message : '签到请求被拒绝' }
  }
  const typed = body as { alreadyCheckedIn?: unknown; claim?: { credit?: unknown } } | undefined
  if (typed?.alreadyCheckedIn === true) return { outcome: 'alreadyClaimed', credit: 0 }
  const credit = typed?.claim?.credit
  return {
    outcome: 'claimed',
    ...typeof credit === 'number' && Number.isFinite(credit) ? { credit } : {},
  }
}

/**
 * 区域切换后，上一批的结论归属哪个区域。
 *
 * 交接文档 4.3：「切换区域后批次仍按原 ID 集合收尾，其结果归属于启动时区域。」
 * 所以批次一开始就把区域记下来，之后界面切到哪都不改它 —— 否则国内批次的结果
 * 会出现在国际卡片上。
 */
export interface BatchScope {
  readonly region: string
  readonly startedAt: number
}

export function batchScope(region: string, now: number): BatchScope {
  return { region, startedAt: now }
}

/**
 * 「重新检测」的一次完整往返。
 *
 * 交接文档 4.3 的原文是：POST POOL_RESCAN_PATH 扫**全池**，响应 `accounts` 是全池数；
 * 回读要求是「重读两区，当前页区域数量取区域快照」。三件事都容易写错，而且都真错过：
 *
 * 1. 只刷一个区 —— 另一个区还是旧数据，而 rescan 动的是全池，两边可能一起变了；
 * 2. 拿响应里的 `accounts` 当某一区的数量 —— 它答的是全池，两区各有几个得读区域状态；
 * 3. 只重读账号不重读余额 —— 重新扫出来的账号余额还是空。
 *
 * 所以抽成一个函数：一次 rescan，然后每个区域各读一次，返回的 `byRegion` **只**来自
 * 区域快照。`total` 保留 rescan 自己的答案，因为它答的就是这个。
 */
export interface RescanOutcome {
  /** rescan 自己报的全池账号数。 */
  readonly total: number
  /** 每个区域各自快照里的账号数；读不到的区域是 `undefined`。 */
  readonly byRegion: Readonly<Record<string, number | undefined>>
}

export async function rescanRegions(options: {
  /** 发一次全池 rescan，返回它的 `accounts`。 */
  readonly rescan: () => Promise<number>
  /** 重读一个区域，返回该区快照里的账号数；读不到返回 undefined。 */
  readonly refresh: (region: string) => Promise<number | undefined>
  readonly regions: readonly string[]
}): Promise<RescanOutcome> {
  const total = await options.rescan()
  /*
    两区并发读：它们互不依赖，串起来只会让用户多等一个往返。用 allSettled 而不是
    all —— 一个区域读不到不该让另一个区域的结果也丢掉。
  */
  const settled = await Promise.allSettled(options.regions.map(region => options.refresh(region)))
  const byRegion: Record<string, number | undefined> = {}
  options.regions.forEach((region, index) => {
    const outcome = settled[index]
    byRegion[region] = outcome?.status === 'fulfilled' ? outcome.value : undefined
  })
  return { total, byRegion }
}

/**
 * 这一家渠道的「全部领取」该走哪条路。
 *
 * 3.2.0 的答案是固定的：先看有没有自有签到路由，否则一律 `credits.claimAll`。于是
 * WorkBuddy 两条 lane（账号来自插件池）也走了渠道包 —— 包只认得它自己那两个账号，
 * 池里另外两个一次都没被提交，而界面上的按钮写着「全部领取」。
 *
 * 抽成纯函数是为了让这条判断可以被断言，而不是只藏在 JSX 的 if 里。
 */
export type ClaimRoute = 'pool' | 'own' | 'pack'

export function claimRouteFor(input: {
  readonly hasPoolLane: boolean
  readonly hasOwnCheckinRoute: boolean
}): ClaimRoute {
  if (input.hasPoolLane) return 'pool'
  if (input.hasOwnCheckinRoute) return 'own'
  return 'pack'
}

/**
 * 这个批次的结果还该不该渲染到某张卡上。
 *
 * 只有当卡片正在显示的区域 == 批次启动时的区域才渲染。批次本身照旧跑完
 * （见 runBatch：abort 只阻止开始新的账号），所以切回来还能看到结果。
 */
export function batchVisibleIn(scope: BatchScope | undefined, region: string): boolean {
  return scope === undefined || scope.region === region
}
