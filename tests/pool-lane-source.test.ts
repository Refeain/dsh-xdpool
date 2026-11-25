import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 这两条 WorkBuddy lane 的账号到底以谁为准。
 *
 * 用户报的是一句话：「我的 workbuddy 国内版本还是显示 2 个账号」，而后端
 * `/plugins/dsh-xdpool/status?region=cn` 明明回了 4 个。原因不是数据丢了，是页面读错了表：
 * 详情页取的是 channel-pack 的 `account.list`，那里面有 2 条；插件池的 4 条挂在一条
 * 从未被写入的 `selectedChannel` 状态后面，永远渲染不到。
 *
 * 所以这里钉住的是「同一个数只有一份来源」：
 *   · PoolCard 把插件池的账号按渠道 id 交给 ChannelPoolSection（poolLanes）
 *   · ChannelPoolSection 在这两条 lane 上不再读 pack 的账号表
 *
 * 注意这些断言读的是源码文本，不是渲染结果 —— 它们能挡住「又接回 pack」这种改动，
 * 但挡不住布局问题，那要靠真实渲染实测。
 */
const pool = readFileSync(new URL('../src/client/PoolCard.tsx', import.meta.url), 'utf8')
const section = readFileSync(new URL('../src/client/ChannelPoolSection.tsx', import.meta.url), 'utf8')

describe('the two WorkBuddy lanes read the pool, not the pack', () => {
  it('hands the pool accounts down by channel id', () => {
    // 键必须就是 REGION_CHANNEL_BY_REGION 的两个值（buddy / workbuddy），
    // 否则 laneOf() 查不到，页面又退回 pack 那份。
    expect(pool).toContain('[REGION_CHANNEL_BY_REGION.cn]: laneFor(\'cn\')')
    expect(pool).toContain('[REGION_CHANNEL_BY_REGION.global]: laneFor(\'global\')')
    expect(pool).toContain('poolLanes={poolLanes}')
  })

  it('has no write-less selection state left behind', () => {
    /*
      上一版的病根：`const [selectedChannel, setSelectedChannel] = useState('')`
      —— setter 全项目零调用，于是 `showPoolAccounts` 恒 false，账号卡永远不渲染。
      一个 useState 只声明不写入，就是这种死状态，钉住比记笔记靠谱。
    */
    expect(pool).not.toContain('selectedChannel')
    expect(pool).not.toContain('showPoolAccounts')
    expect(section).not.toContain('regionCards')
  })

  it('counts accounts per lane instead of per pack row', () => {
    /*
      中栏行上的数字、「已登录 / 未登录」分组、KPI 的账号数、今日已领的分母，
      都走同一对函数。否则左边写 4、右边画 2 —— 那正是用户看到的画面。
    */
    expect(section).toContain('const rowAccountCount = (entry: ChannelEntry): number =>')
    expect(section).toContain('const rowEnabledCount = (entry: ChannelEntry): number =>')
    expect(section).toContain('entries.reduce((sum, entry) => sum + rowAccountCount(entry), 0)')
    expect(section).toContain('entries.filter(entry => rowAccountCount(entry) > 0)')
    // 详情页里这几个数都必须用 lane 派生量
    expect(section).toContain('String(shownEnabled)')
    expect(section).toContain('String(shownAccounts)')
    expect(section).toContain('${String(claimedToday)}/${String(shownEnabled)}')
  })

  it('draws the pool accounts on those lanes and the pack rows everywhere else', () => {
    // lane 存在 → 池的账号；不存在 → 原来的 pack 账号卡。
    expect(section).toContain('{lane === undefined ? null : (')
    expect(section).toContain('{lane !== undefined ? null : accounts.length === 0 ? (')
    // 两条 lane 的卡面要能签到 / 停用 / 设首选（数据来自 PoolLaneBinding）
    expect(section).toContain('lane.onClaim(account.id)')
    expect(section).toContain('lane.onToggle(account.id, !account.disabled)')
    expect(section).toContain('lane.onPrefer(account.preferred ? null : account.id)')
  })

  it('paints those cards with the design system, not a second visual language', () => {
    /*
      AGENTS.md 的硬规则：界面只有一个来源（xdpool-design）。
      3.0.4 挂回 2.x 的 AccountBlock、3.0.6 自造 `xdp-acct*`，两次都让用户看到
      排布坏掉的账号池。

      所以 lane 的账号卡必须用设计稿已有的 `.acct / .acct-head / .acct-total /
      .acct-detail` 画；`account-card.tsx` 那套自造类名不许出现在渲染里。
    */
    expect(section).not.toContain("from './account-card.tsx'")
    expect(section).not.toMatch(/className="xdp-/u)
    for (const cls of ['className="accts"', 'className="acct"', 'className="acct-head"',
      'className="acct-total"', 'className="acct-detail"']) {
      expect(section, `${cls} 应出现在账号渲染里`).toContain(cls)
    }
  })
})
