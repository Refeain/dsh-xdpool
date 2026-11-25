/**
 * 已忽略账号的恢复：取清单、判定四种结局。
 *
 * 交接文档 4.3 对「忽略与恢复」的约定：
 *
 * - `POST POOL_ACCOUNT_IGNORE_PATH`，body 为 `accountId` 和 `ignored`；
 * - 「重读两区和全池忽略清单」；
 * - 「基线 index.ts 在 ignored=false 时已经执行 scan，前端成功后直接回读」；
 * - 「服务端返回失败时先根据实际结果反馈」。
 *
 * T5 要求分别模拟四条路径：仍有凭据、凭据缺失、解除忽略成功但扫描失败、写忽略失败。
 * 四种结局里只有第一种是真正的"成功"，而界面上它们很容易都被写成"已恢复" ——
 * 第三种尤其危险：忽略解除是真的，但账号没回到池里，用户以为能用了。
 */

/** 已忽略清单里的一行。字段与 `PoolWebIgnoredAccount` 一致，但在这里重新声明。 */
export interface IgnoredEntry {
  readonly id: string
  readonly label: string
  readonly ignoredAt: string
}

/**
 * 从 status 文档里取已忽略清单。
 *
 * 这份清单是**全池**数据（不受 `?region=` 影响），所以两个区的响应应当一样；
 * 任何一份到了就够画，不需要拼接。畸形项直接丢掉：这个列表的唯一用途是提供恢复入口，
 * 一条没有 id 的记录点了也没法恢复。
 */
export function ignoredFrom(status: unknown): IgnoredEntry[] {
  if (status === null || typeof status !== 'object') return []
  const list = (status as { ignored?: unknown }).ignored
  if (!Array.isArray(list)) return []
  const rows: IgnoredEntry[] = []
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue
    const id = (raw as { id?: unknown }).id
    if (typeof id !== 'string' || id === '') continue
    const label = (raw as { label?: unknown }).label
    const ignoredAt = (raw as { ignoredAt?: unknown }).ignoredAt
    rows.push({
      id,
      // 标签只是呈现用，缺了就用 id —— 与账号行上的 `nickname ?? name ?? id` 同一个原则。
      label: typeof label === 'string' && label !== '' ? label : id,
      ignoredAt: typeof ignoredAt === 'string' ? ignoredAt : '',
    })
  }
  return rows
}

/**
 * 一次恢复的结局。
 *
 * `restored` 之外的三项都是"不成功"，但原因不同，界面必须分开说：一个是本机没有这份
 * 凭据了（要重新登录），一个是恢复动作本身没成（要重试），一个是状态没能读回来
 * （不知道成没成，要刷新）。
 */
export type RestoreOutcome =
  /** 解除忽略成功，且回读后账号确实回到了池里。 */
  | { readonly kind: 'restored'; readonly label: string }
  /** 解除忽略成功，但回读里没有这个账号 —— 本机的凭据已经不在了。 */
  | { readonly kind: 'missingCredential'; readonly label: string }
  /** 解除忽略成功，但回读本身失败。真实状态未知。 */
  | { readonly kind: 'scanFailed'; readonly label: string; readonly error: string }
  /** 写忽略清单就失败了，账号仍在忽略列表里。 */
  | { readonly kind: 'failed'; readonly label: string; readonly error: string }

/** 服务端对一次 ignore/unignore 的答复。 */
export interface RestoreResponse {
  /** HTTP 层面成功（`response.ok`）。 */
  readonly ok: boolean
  /** 失败时服务端给的理由，或 HTTP 状态。 */
  readonly error?: string | undefined
}

/**
 * 判定一次恢复的结局。
 *
 * 顺序不能换：**先看写有没有成功**。写失败时说"账号缺失"会把用户推去重新登录一个
 * 根本没被动过的账号；说"状态待刷新"更是暗示它可能已经好了。
 *
 * @param present 回读到账号是否已在池中；`undefined` = 回读失败
 */
export function classifyRestore(input: {
  readonly label: string
  readonly response: RestoreResponse
  readonly present: boolean | undefined
  readonly refreshError?: string | undefined
}): RestoreOutcome {
  const { label, response, present } = input
  if (!response.ok) {
    return { kind: 'failed', label, error: response.error ?? '恢复请求被拒绝' }
  }
  if (present === undefined) {
    return { kind: 'scanFailed', label, error: input.refreshError ?? '状态回读失败' }
  }
  if (!present) return { kind: 'missingCredential', label }
  return { kind: 'restored', label }
}

/**
 * 把结局翻成给用户看的一句话。
 *
 * 「恢复后未发现账号时提示重新登录或检测」（T5）落在 `missingCredential` 这一支。
 * `scanFailed` 不能说成"已恢复"：忽略解除确实发生了，但账号还没回到池里，
 * 用户此刻发请求仍然用不上它。
 */
export function restoreMessage(outcome: RestoreOutcome): string {
  switch (outcome.kind) {
    case 'restored':
      return `已把 ${outcome.label} 放回池子`
    case 'missingCredential':
      return `已解除对 ${outcome.label} 的忽略，但没有找到它的凭据 —— 请重新登录这个账号，或点「重新检测」确认本机还有哪些账号`
    case 'scanFailed':
      return `${outcome.label} 的忽略已解除，但状态没能读回来（${outcome.error}）。刷新后确认它是否已经回到池子`
    case 'failed':
      return `解除 ${outcome.label} 的忽略失败：${outcome.error}`
  }
}

/** 这个结局算不算成功 —— 决定提示条用普通语气还是警告语气。 */
export function restoreSucceeded(outcome: RestoreOutcome): boolean {
  return outcome.kind === 'restored'
}
