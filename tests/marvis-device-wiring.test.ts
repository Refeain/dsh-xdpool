/**
 * T6 / F7 的接线守卫：设备号拿不到时，路由要说人话。
 *
 * 三处调用点，三种不同的正确反应：
 *
 *   - 会话路由（GET session）：设备号只是给支持线程对照用的，**不该让整页 500**。
 *     3.2.0 直接调 `deviceGuid()`，没有稳定输入时抛出去，页面变成空白 500 ——
 *     而这一页存在的意义正是解释 Marvis 为什么用不了。
 *   - 两条登录路由：用户主动点了"登录"，缺设备号要变成一句能读的失败原因，
 *     两条路由的 catch 已经统一答 `{ ok: false, reason }`，所以这里抛是对的。
 *
 * 纯行为在 tests/marvis-device.test.ts（13 个用例）。这里只管三处调用点是否分开处理。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const routes = readFileSync(new URL('../src/marvis-routes.ts', import.meta.url), 'utf8')
const login = readFileSync(new URL('../src/marvis-login.ts', import.meta.url), 'utf8')

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const routeCode = codeOnly(routes)
const loginCode = codeOnly(login)

describe('会话路由报告设备问题，而不是抛出去', () => {
  it('用 deviceIdentity() 而不是 deviceGuid()', () => {
    expect(routeCode).toContain('const device = deviceIdentity()')
    expect(routeCode).toContain("...device.ok ? { guid: device.guid, deviceSource: device.source } : {}")
  })

  it('没有设备号时给出 deviceProblem', () => {
    // 这一格是 F7「返回可诊断错误」的落点：界面上没有它，用户只能看到一个缺字段的响应。
    expect(routeCode).toContain('...device.ok ? {} : { deviceProblem: device.problem }')
  })

  it('会话路由里不再直接调 deviceGuid()', () => {
    /*
      这一条防的是"改回去"。`deviceGuid()` 在会话路由上等于把「这台机器没有设备」
      变成一张 500 的页面，而且是在专门用来解释 Marvis 用不了的那一页上。
    */
    const sessionBlock = routeCode.slice(
      routeCode.indexOf('const disposeSession'),
      routeCode.indexOf('const disposeLogin'),
    )
    expect(sessionBlock).not.toContain('deviceGuid()')
    expect(sessionBlock).toContain('deviceIdentity()')
  })
})

describe('两条登录路由把失败变成理由', () => {
  it('都走 requireGuid()，而不是各写一遍', () => {
    /*
      两个调用点各写一遍就会漂成一个抛、一个吞。requireGuid 的存在就是为了让它们
      不能漂：它只有一行，但它是一个可以断言的对象。
    */
    expect(routeCode).toContain('const requireGuid = (): string => deviceGuid()')
    const uses = routeCode.split('guid: requireGuid(),').length - 1
    expect(uses, '两条登录路由都应使用 requireGuid').toBe(2)
  })

  it('两条路由的失败分支都答 ok:false + reason', () => {
    // 这就是"抛是对的"的前提：调用入口会把异常翻译成一句话。
    const reasonAnswers = routeCode.split('{ ok: false, reason:').length - 1
    expect(reasonAnswers).toBeGreaterThanOrEqual(3)
  })
})

describe('browserLogin 自己处理设备号缺失', () => {
  it('捕获 DeviceIdUnavailableError 并转成 { ok: false, reason }', () => {
    /*
      这是一条用户主动发起的登录。缺设备号不该从 browserLogin 里抛出去变成 500 ——
      用户点了「登录」，看到的应该是"这台机器没有可用的设备标识"这类实情。
    */
    expect(loginCode).toContain('if (cause instanceof DeviceIdUnavailableError) return { ok: false, reason: cause.problem }')
    expect(loginCode).toContain("import { DeviceIdUnavailableError, deviceGuid } from './marvis-device.ts'")
  })

  it('其它异常照旧抛出去（不要把真 bug 吞成"设备问题"）', () => {
    expect(loginCode).toContain('throw cause')
  })
})
