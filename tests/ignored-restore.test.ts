import { describe, expect, it } from 'vitest'
import {
  classifyRestore,
  ignoredFrom,
  restoreMessage,
  restoreSucceeded,
} from '../src/client/ignored-restore.ts'

/**
 * T5「恢复账号」的四条路径（交接文档 7 节原文）：
 * 「模拟仍有凭据、凭据缺失、解除忽略成功但扫描失败、写忽略失败四种路径。
 *   恢复后未发现账号时提示重新登录或检测。」
 */
describe('ignoredFrom — 从 status 文档取全池忽略清单', () => {
  it('正常清单原样取出', () => {
    const list = ignoredFrom({
      ignored: [
        { id: 'B', label: 'B 备用', ignoredAt: '2026-11-24T02:00:00.000Z' },
      ],
    })
    expect(list).toEqual([{ id: 'B', label: 'B 备用', ignoredAt: '2026-11-24T02:00:00.000Z' }])
  })

  it('缺 label 时用 id 顶替，不缺就照原样', () => {
    // 与账号行「nickname ?? name ?? id」同一个原则：这个列表唯一的用途是提供恢复入口，
    // 一条没有名字的行比一条用 id 命名的行更难用。
    const list = ignoredFrom({ ignored: [{ id: 'B', ignoredAt: 'x' }] })
    expect(list[0]?.label).toBe('B')
  })

  it('畸形项被丢掉：没有 id 的记录点了也没法恢复', () => {
    const list = ignoredFrom({
      ignored: [
        { label: '没有 id' },
        { id: '' },
        'not an object',
        null,
        { id: 'C', label: 'C 老号', ignoredAt: '' },
      ],
    })
    expect(list.map(row => row.id)).toEqual(['C'])
  })

  it('status 缺 ignored 字段时是空清单，不是异常', () => {
    // 旧版后端可能不给这一格。空清单等于"没有可恢复的账号"，界面不画那一块。
    expect(ignoredFrom({ accounts: [] })).toEqual([])
    expect(ignoredFrom({ ignored: 'nope' })).toEqual([])
    expect(ignoredFrom(undefined)).toEqual([])
    expect(ignoredFrom(null)).toEqual([])
  })
})

describe('classifyRestore — 四条路径分得开', () => {
  const label = 'B 备用'
  const ok = { ok: true } as const

  it('仍有凭据：解除成功且账号回到池里', () => {
    const outcome = classifyRestore({ label, response: ok, present: true })
    expect(outcome).toEqual({ kind: 'restored', label })
    expect(restoreSucceeded(outcome)).toBe(true)
  })

  it('凭据缺失：解除成功但回读里没有它', () => {
    const outcome = classifyRestore({ label, response: ok, present: false })
    expect(outcome).toEqual({ kind: 'missingCredential', label })
    // 这一支必须提示重新登录或检测 —— 用户需要知道自己该做什么。
    const message = restoreMessage(outcome)
    expect(message).toContain('重新登录')
    expect(message).toContain('重新检测')
    expect(restoreSucceeded(outcome)).toBe(false)
  })

  it('解除成功但扫描失败：真实状态未知，不能说成已恢复', () => {
    const outcome = classifyRestore({
      label,
      response: ok,
      present: undefined,
      refreshError: 'HTTP 502',
    })
    expect(outcome).toEqual({ kind: 'scanFailed', label, error: 'HTTP 502' })
    const message = restoreMessage(outcome)
    // 忽略确实解除了（这句要说），但账号还没回到池里（这句也要说）。
    expect(message).toContain('忽略已解除')
    expect(message).toContain('HTTP 502')
    expect(message).not.toContain('已把')
    expect(restoreSucceeded(outcome)).toBe(false)
  })

  it('写忽略失败：账号仍在忽略列表里，理由是服务端给的', () => {
    const outcome = classifyRestore({
      label,
      response: { ok: false, error: 'invalid account ignore payload' },
      present: false,
    })
    expect(outcome).toEqual({
      kind: 'failed',
      label,
      error: 'invalid account ignore payload',
    })
    expect(restoreMessage(outcome)).toContain('invalid account ignore payload')
    expect(restoreSucceeded(outcome)).toBe(false)
  })

  it('写失败优先于一切：不能因为"回读里没有"就说成凭据缺失', () => {
    /*
      顺序错了的后果很具体：写失败 + present=false 会被误判成 missingCredential，
      于是界面把用户推去重新登录一个根本没被动过的账号。
    */
    const outcome = classifyRestore({
      label,
      response: { ok: false, error: 'HTTP 500' },
      present: false,
    })
    expect(outcome.kind).toBe('failed')
  })

  it('写失败时即使回读成功也不说"已恢复"', () => {
    const outcome = classifyRestore({
      label,
      response: { ok: false, error: 'HTTP 500' },
      present: true,
    })
    expect(outcome.kind).toBe('failed')
    expect(restoreSucceeded(outcome)).toBe(false)
  })

  it('服务端拒绝但没给理由时有兜底文案', () => {
    const outcome = classifyRestore({ label, response: { ok: false }, present: false })
    expect(outcome.kind).toBe('failed')
    if (outcome.kind === 'failed') expect(outcome.error).not.toBe('')
  })

  it('回读失败但没带错误时也有兜底文案', () => {
    const outcome = classifyRestore({ label, response: ok, present: undefined })
    expect(outcome.kind).toBe('scanFailed')
    if (outcome.kind === 'scanFailed') expect(outcome.error).not.toBe('')
  })
})

describe('恢复提示语区分四种结局', () => {
  const cases = [
    classifyRestore({ label: 'B', response: { ok: true }, present: true }),
    classifyRestore({ label: 'B', response: { ok: true }, present: false }),
    classifyRestore({ label: 'B', response: { ok: true }, present: undefined, refreshError: 'boom' }),
    classifyRestore({ label: 'B', response: { ok: false, error: 'boom' }, present: false }),
  ]

  it('四句话互不相同 —— 否则界面等于没区分', () => {
    const messages = cases.map(restoreMessage)
    expect(new Set(messages).size).toBe(4)
  })

  it('只有第一种算成功', () => {
    expect(cases.map(restoreSucceeded)).toEqual([true, false, false, false])
  })
})
