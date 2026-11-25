/**
 * The device id Marvis expects on every request.
 *
 * WHERE IT COMES FROM
 *
 * `HKCU\SOFTWARE\Tencent\Marvis\Env\svid` when the client is installed. Without it the
 * service answers `-109 RC_PARAMS_INVALID` on the very first exchange — the parameter check runs
 * BEFORE the code is validated, so a missing guid reads like a malformed request and is actually
 * a missing device.
 *
 * A machine without the client derives the same 32-hex shape from its own name and user. It is
 * stable per machine, so a re-login does not produce a new device, and it needs no binary — the
 * reference implementation once shipped four DLLs to sign this and no longer does.
 *
 * WHEN THERE IS NO USER (F7)
 *
 * `os.userInfo()` THROWS rather than returning blanks on a platform where the running user has
 * no entry — a service context, a container, a stripped-down image. 3.2.0 called it unguarded
 * inside the derivation, so `deviceGuid()` threw from three call sites, and the failure read as
 * whatever the caller did with an uncaught exception. Worse, the obvious "fix" of catching it
 * and substituting `Date.now()` or `Math.random()` would mint a NEW device on every call, which
 * the upstream treats as a fleet of new machines.
 *
 * So the fallback is a SECOND STABLE INPUT, not a random one: the same machine+user environment
 * variables the platform sets. Their stable boundary is written down at {@link environmentUser}
 * — they are per-machine and per-login, not per-process, which is exactly the granularity a
 * device id needs. When even those are absent, this module says so in a diagnosable way instead
 * of inventing an identity: {@link deviceIdentity} returns a problem, and each call site decides
 * how to report it.
 *
 * @module dsh-xdpool/marvis-device
 */
import { createHash } from 'node:crypto'
import { hostname, userInfo } from 'node:os'
import { spawnSync } from 'node:child_process'

/** The registry value the client writes. */
const SVID_KEY = 'HKCU\\SOFTWARE\\Tencent\\Marvis\\Env'

/** What the derivation was built from. Printed in diagnostics so support can compare. */
export interface DeviceIdSource {
  /** `registry` = the installed client's own id; the other two are derived. */
  readonly kind: 'registry' | 'machine' | 'environment'
  /** One line naming the actual inputs, with no secret in it. */
  readonly detail: string
}

/** The device id, or why there is not one. */
export type DeviceIdentity =
  | { readonly ok: true; readonly guid: string; readonly source: DeviceIdSource }
  | { readonly ok: false; readonly problem: string }

/** Thrown by {@link deviceGuid} when no stable identity can be derived. */
export class DeviceIdUnavailableError extends Error {
  constructor(readonly problem: string) {
    super(problem)
    this.name = 'DeviceIdUnavailableError'
  }
}

/**
 * Cached: the lookup runs a synchronous `reg query`, and this is called per request.
 *
 * Failures are cached too. A failing derivation would otherwise pay the 3s `reg.exe` timeout on
 * every single request, and the inputs cannot change inside one process lifetime anyway.
 */
let cached: DeviceIdentity | undefined

/** The registry value, or undefined when the client is not installed. */
function fromRegistry(): string | undefined {
  if (process.platform !== 'win32') return undefined
  try {
    const out = spawnSync('reg', ['query', SVID_KEY, '/v', 'svid'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    })
    const match = /svid\s+REG_SZ\s+([0-9a-fA-F]{32})/u.exec(String(out.stdout ?? ''))
    return match?.[1]?.toLowerCase()
  } catch {
    return undefined
  }
}

/** `hostname()` without the throw: it is a syscall and can fail in a locked-down runtime. */
function safeHostname(): string | undefined {
  try {
    const value = hostname()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/** The username from `os.userInfo()`, or why it could not be read. */
function systemUser(): { readonly username: string } | { readonly problem: string } {
  try {
    const username = userInfo().username
    return username === '' ? { problem: 'userInfo() 返回了空用户名' } : { username }
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return { problem: `userInfo() 读取失败：${message}` }
  }
}

/**
 * The fallback user input, from the environment.
 *
 * STABLE BOUNDARY — what makes this safe to substitute for `os.userInfo()`:
 *
 *   - All of these are set once per LOGIN by the OS/terminal, not per process, so repeated calls
 *     inside one run and across restarts on the same machine+user agree.
 *   - They are read in a fixed order, so an environment that sets several always derives the
 *     same one. Adding a name to the front of this list WOULD change the derived id for machines
 *     whose userInfo also fails — that is a last-resort path, but worth knowing.
 *   - They can legitimately be absent (a Windows service with a scrubbed environment, a
 *     container running as an unnamed uid). That is the case this module reports instead of
 *     guessing.
 *
 * What is deliberately NOT here: `Math.random()`, `Date.now()`, `process.pid`, or a freshly
 * generated uuid. Any of those would present a second device to the upstream on every call.
 */
function environmentUser(): string | undefined {
  const names = ['USERNAME', 'USER', 'LOGNAME'] as const
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  return undefined
}

/** The fallback machine input, from the environment, when `hostname()` itself failed. */
function environmentMachine(): string | undefined {
  const names = ['COMPUTERNAME', 'HOSTNAME'] as const
  for (const name of names) {
    const value = process.env[name]
    if (value !== undefined && value.trim() !== '') return value.trim()
  }
  return undefined
}

function digest(seed: string): string {
  return createHash('md5').update(seed).digest('hex')
}

/** Resolve the identity from scratch. Called once per process (see {@link cached}). */
function resolve(): DeviceIdentity {
  const registry = fromRegistry()
  if (registry !== undefined) {
    return {
      ok: true,
      guid: registry,
      source: { kind: 'registry', detail: `注册表 ${SVID_KEY}\\svid` },
    }
  }

  const machine = safeHostname()
  const user = systemUser()
  /*
    正常路径：与 3.2.0 逐字一致的派生方式。

    这一条不能改。已经登录过的机器靠它算出同一个 id，换了算法等于把自己变成一台新设备，
    上游会要求重新授权 —— 而用户什么都没做。
  */
  if (machine !== undefined && 'username' in user) {
    return {
      ok: true,
      guid: digest(`${machine}|${user.username}|marvis`),
      source: { kind: 'machine', detail: `主机名 + 系统用户名（${machine}|${user.username}）` },
    }
  }

  // 系统用户名读不到：改用环境变量这一份稳定输入。
  const envUser = environmentUser()
  const envMachine = machine ?? environmentMachine()
  if (envUser !== undefined && envMachine !== undefined) {
    return {
      ok: true,
      guid: digest(`${envMachine}|${envUser}|marvis-env`),
      source: {
        kind: 'environment',
        detail: `环境变量用户名 + 主机名（${envMachine}|${envUser}）—— ${'problem' in user ? user.problem : '主机名不可用'}`,
      },
    }
  }

  // 到这里就没有可用的稳定输入了。给一句能查的话，而不是编一个 id。
  const missing = [
    ...envUser === undefined ? ['环境变量里没有 USERNAME / USER / LOGNAME'] : [],
    ...envMachine === undefined ? ['主机名与环境变量里都没有 COMPUTERNAME / HOSTNAME'] : [],
  ]
  return {
    ok: false,
    problem: [
      '无法确定这台机器的稳定设备标识',
      'problem' in user ? user.problem : '主机名不可用',
      ...missing,
      '请安装 Marvis 客户端（提供注册表 svid），或在带有用户名与主机名的环境下启动。',
    ].join('；'),
  }
}

/** The identity, resolved once and cached. */
export function deviceIdentity(): DeviceIdentity {
  cached ??= resolve()
  return cached
}

/**
 * The device id.
 *
 * Always 32 lowercase hex: the service rejects any other shape, and a per-call value would make
 * every request look like a new device.
 *
 * @throws {DeviceIdUnavailableError} when no stable input exists — see {@link deviceIdentity}
 * for the branch that lets a call site report it in its own words instead.
 */
export function deviceGuid(): string {
  const identity = deviceIdentity()
  if (!identity.ok) throw new DeviceIdUnavailableError(identity.problem)
  return identity.guid
}

/** Drop the cache, for a test or after the environment changed. */
export function resetDeviceCache(): void {
  cached = undefined
}
