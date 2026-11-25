/**
 * F7 / T6：设备号在拿不到稳定输入时必须可诊断，而不是抛给调用方一个未捕获异常。
 *
 * 交接文档 T6 的验收：
 *   「模拟注册表缺失和userInfo抛错，验证重复调用及重新初始化结果。」
 *   「无可靠输入时返回可诊断错误并由调用入口处理。」
 *   「正常userInfo可用时保持原派生算法。」
 *
 * 这里 `vi.mock('node:os')` 直接换掉 userInfo / hostname，因为要模拟的正是
 * 「平台上没有当前用户的条目」——那种环境里 userInfo() 是**抛异常**，不是返回空串。
 * `spawnSync` 也被替换，代表「此机未安装 Marvis 客户端」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

const osState = {
  userThrows: false,
  usernameValue: 'yy tester',
  hostnameValue: 'DEV-BOX',
}

vi.mock('node:os', async importOriginal => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    hostname: (): string => osState.hostnameValue,
    userInfo: (): ReturnType<typeof actual.userInfo> => {
      if (osState.userThrows) throw new Error('no entry for the current user')
      return { ...actual.userInfo(), username: osState.usernameValue }
    },
  }
})

/** `reg query` output. Empty = the client is not installed. */
const registryState = { svid: '' }

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawnSync: (): { status: number; stdout: string } => (registryState.svid === ''
      ? { status: 1, stdout: '' }
      : {
          status: 0,
          stdout: `HKEY_CURRENT_USER\\SOFTWARE\\Tencent\\Marvis\\Env\r\n    svid    REG_SZ    ${registryState.svid}\r\n`,
        }),
  }
})

const ENV_KEYS = ['USERNAME', 'USER', 'LOGNAME', 'COMPUTERNAME', 'HOSTNAME'] as const

/** Set exactly the environment the case needs, and nothing else from the runner's own env. */
function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) process.env[key] = value
}

async function fresh(): Promise<typeof import('../src/marvis-device.ts')> {
  vi.resetModules()
  return import('../src/marvis-device.ts')
}

describe('registry first', () => {
  afterEach(() => { registryState.svid = '' })

  it('the installed client id wins over any derivation', async () => {
    /*
      装了客户端就必须用它的 svid —— 这台机器在上游已经以那个 id 存在了，
      自己再推一个出来就是第二台设备。
    */
    registryState.svid = 'f'.repeat(32)
    setEnv({ USERNAME: 'someone' })
    const identity = (await fresh()).deviceIdentity()
    expect(identity.ok).toBe(true)
    if (!identity.ok) return
    expect(identity.guid).toBe('f'.repeat(32))
    expect(identity.source.kind).toBe('registry')
    expect(identity.source.detail).toContain('Tencent\\Marvis')
  })

  it('registry id also covers the userInfo-throws case', async () => {
    // 装了客户端时根本不必去问 userInfo，所以那边抛不抛都不影响。
    registryState.svid = 'a1b2c3d4'.repeat(4)
    osState.userThrows = true
    const identity = (await fresh()).deviceIdentity()
    expect(identity.ok).toBe(true)
    if (!identity.ok) return
    expect(identity.guid).toBe('a1b2c3d4'.repeat(4))
  })
})

describe('the normal derivation is unchanged', () => {
  beforeEach(() => {
    osState.userThrows = false
    osState.usernameValue = 'yy tester'
    osState.hostnameValue = 'DEV-BOX'
    setEnv({})
  })

  it('hostname + userInfo().username hashed exactly as 3.2.0 did', async () => {
    /*
      这一条不能漂。已经登录过的机器靠它算出同一个 id，换算法等于把自己变成一台新设备，
      上游会要求重新授权 —— 而用户什么都没做。所以这里自己算一遍 md5 来对。
    */
    const module = await fresh()
    const identity = module.deviceIdentity()
    expect(identity.ok).toBe(true)
    if (!identity.ok) return
    expect(identity.guid).toBe(createHash('md5').update('DEV-BOX|yy tester|marvis').digest('hex'))
    expect(identity.source.kind).toBe('machine')
  })

  it('repeated calls inside one process return the same id', async () => {
    const module = await fresh()
    const first = module.deviceGuid()
    const second = module.deviceGuid()
    expect(second).toBe(first)
  })

  it('re-initialising from the same inputs lands on the same id', async () => {
    // 「重新初始化结果」要一致 —— 否则每次进程重启都是一台新设备。
    const first = (await fresh()).deviceGuid()
    const second = (await fresh()).deviceGuid()
    expect(second).toBe(first)
  })
})

describe('userInfo throws: fall back to a stable environment input', () => {
  beforeEach(() => {
    osState.userThrows = true
    osState.hostnameValue = 'DEV-BOX'
  })

  it('derives from the environment, and says so', async () => {
    setEnv({ USERNAME: 'env-user', COMPUTERNAME: 'ENV-BOX' })
    const module = await fresh()
    const identity = module.deviceIdentity()
    expect(identity.ok).toBe(true)
    if (!identity.ok) return
    expect(identity.source.kind).toBe('environment')
    expect(identity.guid).toBe(createHash('md5').update('DEV-BOX|env-user|marvis-env').digest('hex'))
    // 诊断信息要带上"为什么走了回退"
    expect(identity.source.detail).toContain('userInfo() 读取失败')
  })

  it('the fallback id is stable across repeated calls and re-initialisation', async () => {
    /*
      这是 T6 点名的雷：「避免每次调用随机生成身份」。

      随手写 Date.now() / Math.random() / randomUUID() 都能让测试里"有个 32 hex"通过，
      却会让每一台没有用户条目的机器在上游眼里是一批新设备。所以这里同时查
      "同进程两次"与"重新初始化一次"，两者都必须相等。
    */
    setEnv({ USERNAME: 'env-user', COMPUTERNAME: 'ENV-BOX' })
    const module = await fresh()
    const first = module.deviceGuid()
    expect(module.deviceGuid()).toBe(first)
    const again = (await fresh()).deviceGuid()
    expect(again).toBe(first)
    expect(first).not.toMatch(/[^0-9a-f]/u)
    expect(first).toHaveLength(32)
  })

  it('reads the environment names in a fixed order', async () => {
    /*
      固定顺序的意思是"优先级确定"，不是"设了几个都一样"：
      先有 USERNAME 就用它；把 USERNAME 从环境里去掉，才轮到 USER。

      这条要钉住的是**优先级不会随环境变量的存在顺序摆动** —— 同一组变量，
      谁先被读到必须是同一个。反过来（少了更高优先级的名字就换人）是正确的行为，
      不是缺陷：那种情况下机器给的输入确实变了。
    */
    /* hostname() 本身可用，所以机器这一半仍然取 DEV-BOX；只有用户名来自环境 */
    const onlyUser = createHash('md5').update('DEV-BOX|second|marvis-env').digest('hex')
    const withUserName = createHash('md5').update('DEV-BOX|first|marvis-env').digest('hex')

    setEnv({ USERNAME: 'first', USER: 'second', LOGNAME: 'third', COMPUTERNAME: 'ENV-BOX' })
    const a = (await fresh()).deviceGuid()
    expect(a).toBe(withUserName)

    // 同一个环境重新初始化，仍然是 USERNAME 胜出
    const again = (await fresh()).deviceGuid()
    expect(again).toBe(withUserName)

    // 去掉 USERNAME 之后才轮到 USER
    setEnv({ USER: 'second', LOGNAME: 'third', COMPUTERNAME: 'ENV-BOX' })
    const b = (await fresh()).deviceGuid()
    expect(b).toBe(onlyUser)
    expect(b).not.toBe(a)
  })

  it('falls back to the environment hostname when hostname() is empty', async () => {
    osState.hostnameValue = ''
    setEnv({ USERNAME: 'env-user', COMPUTERNAME: 'ENV-BOX' })
    const identity = (await fresh()).deviceIdentity()
    expect(identity.ok).toBe(true)
    if (!identity.ok) return
    expect(identity.guid).toBe(createHash('md5').update('ENV-BOX|env-user|marvis-env').digest('hex'))
  })
})

describe('no stable input at all: a diagnosable error, not an invented id', () => {
  beforeEach(() => {
    osState.userThrows = true
    osState.hostnameValue = ''
  })

  it('deviceIdentity() reports the problem instead of throwing', async () => {
    setEnv({})
    const module = await fresh()
    const identity = module.deviceIdentity()
    expect(identity.ok).toBe(false)
    if (identity.ok) return
    // 一句能查的话：缺了什么、下一步做什么
    expect(identity.problem).toContain('无法确定这台机器的稳定设备标识')
    expect(identity.problem).toContain('userInfo() 读取失败')
    expect(identity.problem).toContain('Marvis 客户端')
  })

  it('deviceGuid() throws DeviceIdUnavailableError carrying that problem', async () => {
    setEnv({})
    const module = await fresh()
    expect(() => module.deviceGuid()).toThrow(module.DeviceIdUnavailableError)
    try {
      module.deviceGuid()
    } catch (cause: unknown) {
      expect(cause).toBeInstanceOf(module.DeviceIdUnavailableError)
      expect((cause as InstanceType<typeof module.DeviceIdUnavailableError>).problem)
        .toContain('无法确定这台机器的稳定设备标识')
    }
  })

  it('the failure is cached, so a per-request call does not pay the lookup again', async () => {
    /*
      没有缓存的话，每一次请求都要跑一遍 `reg query` 到 3 秒超时。失败也是结论，
      该记下来。
    */
    setEnv({})
    const module = await fresh()
    const first = module.deviceIdentity()
    const second = module.deviceIdentity()
    expect(second).toBe(first) // 同一个对象 = 只算了一次
  })

  it('never invents an identity: the problem path yields no guid field at all', async () => {
    setEnv({})
    const identity = (await fresh()).deviceIdentity()
    expect(Object.hasOwn(identity, 'guid')).toBe(false)
  })
})

afterEach(() => {
  registryState.svid = ''
  osState.userThrows = false
  osState.usernameValue = 'yy tester'
  osState.hostnameValue = 'DEV-BOX'
  setEnv({})
})
