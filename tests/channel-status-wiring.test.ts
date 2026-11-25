/**
 * T4 的接线守卫：状态读取要真的发出去，自动化面板要真的只在 WorkBuddy 国内页。
 *
 * 两件事都是"函数写好了但没人调用"或"判据写错了对象"的类型，行为测试看不见：
 *
 * 1. `credits.status` 在 3.2.0 里从来没被调用过 —— `creditStatusesFrom` 存在、
 *    `ChannelEntry.statuses` 字段存在，但每一处构造点都写 `[]`。所以纯函数测试
 *    （tests/channel-status.test.ts）全绿，界面上却永远是"未知"。
 * 2. 自动化面板的判据曾是 `canClaim`，注释还写着"调度器遍历所有有账号的渠道"。
 *    那句话对 pack 的 `usage.autoCheckin` 成立，但这一页的 props 接的是
 *    WorkBuddyScheduler，于是第三方渠道上出现了一个"能控制所有渠道"的假开关。
 *
 * 查源码文本，但只查**条件原文**，不查"函数体里出现过这个词"—— 后者实测过一次
 * 空转假绿（把条件改成 `if (false)`，函数体还在，测试照样通过）。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const section = readFileSync(new URL('../src/client/ChannelPoolSection.tsx', import.meta.url), 'utf8')

function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const sectionCode = codeOnly(section)

describe('credits.status 真的被调用', () => {
  it('存在 refreshStatuses，并且发的是 credits.status', () => {
    expect(sectionCode).toContain('const refreshStatuses = async')
    expect(sectionCode).toContain("callPack('credits.status', { provider })")
  })

  it('只有声明了 status 能力的渠道才问', () => {
    /*
      不筛能力的话，二十多家都会收到 "unsupported provider"，那种错误没有信息量，
      却会被当成"读取失败"写进 statusError，让每一家都显示签到不可用。
    */
    expect(sectionCode).toContain("if (capability?.status !== true) return")
  })

  it('首次加载时与余额一起发出（wave 2）', () => {
    expect(sectionCode).toContain('void refreshStatuses(entry.channel.id, true)')
  })

  it('领取后回读状态，而不只回读余额（4.4）', () => {
    /*
      「领取后重新读取本渠道状态和余额」。只读余额会让「今日已领」停在领取前的数字：
      领到了、余额涨了、已领数没动。
    */
    const claimBody = sectionCode.slice(
      sectionCode.indexOf('const claim = async'),
      sectionCode.indexOf('const claim = async') + 1800,
    )
    expect(claimBody).toContain('await refreshBalances(provider, true)')
    expect(claimBody).toContain('await refreshStatuses(provider)')
  })

  it('失败的外层原因写进 statusError，视图才有理由可说', () => {
    expect(sectionCode).toContain('statusError: message')
    expect(sectionCode).toContain('statusError: undefined')
  })
})

describe('自动化面板只在 WorkBuddy 国内页（F5）', () => {
  it('判据是池归属 + 国内区，不再是 canClaim', () => {
    /*
      这一条钉的是**判断条件原文**。曾经写成 `canClaim && onAutoClaim !== undefined`，
      于是每个能签到的第三方渠道都长出这一格，而它接的 props 是
      statusOf('cn')?.automation 与 runAutomationJob('cn') —— 用户以为关掉了自己
      那家的自动领取，实际关的是 WorkBuddy 的调度器。
    */
    expect(sectionCode).toContain("const showAutomation = channel.ownedByPool === true")
    expect(sectionCode).toContain("&& poolRegionOf(channel.id) === 'cn'")
    expect(sectionCode).toContain('&& onAutoClaim !== undefined')
    // 旧判据必须消失，否则两套标准并存，谁先谁后说不清
    expect(sectionCode).not.toContain('const showAutomation = canClaim')
  })

  it('标签明确写 WorkBuddy 账号池，而不是"积分自动化"', () => {
    /*
      原来的 'channelpool.autoClaim' 读起来是"这个渠道的积分自动化"。
      这一页管的只是 WorkBuddy 池，标签必须这么说，否则第三方渠道的读者会误判范围。
    */
    expect(sectionCode).toContain("t?.('channelpool.poolAutomation')")
    expect(sectionCode).toContain("t?.('channelpool.poolAutomationHint')")
  })
})

describe('账号行的签到格是三态，不是两态', () => {
  it('明确 false 才写「未领」，undefined 写「状态未知」', () => {
    /*
      4.4「仅支持手动领取的渠道展示未知签到状态」。
      原来的写法是 `todayCheckedIn === true ? 已领 : 未领` —— 于是"问不到"与
      "确实没签"在界面上长得一模一样，用户没有理由去点「重新检测」。
    */
    expect(sectionCode).toContain('checkin?.todayCheckedIn === false')
    expect(sectionCode).toContain("t?.('channelpool.checkinUnknown')")
  })

  it('读取失败时把理由带出来', () => {
    expect(sectionCode).toContain("t?.('channelpool.checkinUnreadable')")
    expect(sectionCode).toContain('title={chosenEntry.statusError}')
  })
})

describe('locale 键两语齐备', () => {
  const locales = readFileSync(new URL('../src/client/locales.ts', import.meta.url), 'utf8')

  it('poolAutomation 与 poolAutomationHint 在 en / zh 里都有', () => {
    for (const key of [
      'channelpool.poolAutomation',
      'channelpool.poolAutomationHint',
      'channelpool.checkinUnknown',
      'channelpool.checkinUnreadable',
    ]) {
      const occurrences = locales.split(`'${key}':`).length - 1
      expect(occurrences, `${key} 应该出现两次（en + zh）`).toBe(2)
    }
  })
})
