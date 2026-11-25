/**
 * Installing a newer build of this plugin.
 *
 * HOW THE HOST UPDATES A PLUGIN
 *
 * There is no install API to call. A profile's `package.json` names each plugin by a spec, and
 * the host resolves that spec when it starts — so "update" means "change the spec, then restart".
 * That is the whole mechanism, and it is what every plugin that self-updates is really doing.
 *
 * WHAT THIS DOES
 *
 * A newer version is downloaded from the npm registry and checked, and then the
 * profile's dependency is set to that VERSION NUMBER — the ordinary registry
 * spec, not a path. On the next start the host installs that version. Nothing is
 * written outside the profile's own directory, and nothing is changed if the
 * download or the check fails — a half-applied update is worse than an
 * unapplied one.
 *
 * 更新前自动备份：改 package.json 之前，插件的全部数据（账号池、API Key、路由链、各渠道会话、
 * channel-pack 状态、宿主 settings 文档）先复制到 `<插件数据目录>/pre-update/<旧版本>-<时间>/`，
 * 原 spec 写进那里的 restore.json，只保留最近 5 份。复制失败就中止更新，package.json 不动。
 * 回退见 `pre-update-backup.ts` 的 rollbackPackageSpec 和备份目录里的「回退说明.txt」。
 *
 * WHY THE VERSION NUMBER AND NOT A `file:` PATH (it used to be the other way)
 *
 * This used to point the profile at the tarball it had just downloaded
 * (`"dsh-xdpool": "file:C:/Users/…/Temp/dsh-xdpool-3.0.1.tgz"`), on the theory
 * that a registry spec makes the host re-fetch on every start and a slow or
 * proxied registry would leave the plugin unloadable. Three things went wrong
 * with that, all of them reported by users:
 *
 *  1. **The plugin market read it as a local development install.** Its rule is
 *     `link:`/`file:` ⇒ "locally developed", and a locally developed plugin does
 *     not update from the registry — so the entry showed 「本地开发」 and the
 *     next update had nothing to update against.
 *  2. **The path was in the OS temp directory.** A cleanup deleted the tarball
 *     and the profile then pointed at a file that no longer existed: a plugin
 *     that fails to load on the next start, with no obvious cause.
 *  3. **The version shown kept disagreeing with the package.** The market read
 *     the spec's file name while the loaded bundle reported its own constant,
 *     so 「3.0.1.tgz 但是版本号 3.0.0」 was a reachable state.
 *
 * The original worry is handled by pnpm itself: once the version is installed,
 * its store holds the tarball, so a restart does not need the network at all.
 * The download below is therefore a PRE-CHECK — it proves the registry is
 * reachable and the package is a real gzip before anything is written — rather
 * than the thing being installed.
 *
 * A RESTART IS REQUIRED, AND SAYS SO
 *
 * Modules already loaded cannot be swapped in place. The panel reports
 * `restartRequired` and the user restarts when convenient — claiming the update
 * took effect immediately would be a lie the user discovers on the next crash.
 * (The host does reload plugin code between sessions; a running window keeps the
 * modules it started with.)
 *
 * @module dsh-xdpool/update-install
 */
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { checkForUpdate } from './update-check.ts'
import { backupBeforeUpdate, DEPENDENCY_BLOCKS, preUpdateRoot, pruneOldBackups } from './pre-update-backup.ts'
import { POOL_VERSION } from './version.ts'
import {
  fallbackTarballUrl,
  KNOWN_PACKAGE_NAMES,
  PACKAGE_NAME,
  packageFileStem,
  parseVersionMetadata,
} from './update-package.ts'

/** The profile directory whose `package.json` names this plugin. */
function profileDir(): string | undefined {
  // The host sets this for plugins it loaded from a profile; the environment is the only way a
  // plugin can learn where its own spec lives.
  const candidates = [
    process.env['DSH_PROFILE_DIR'],
    process.env['DSH_HOME'] === undefined ? undefined : join(process.env['DSH_HOME'], 'profiles', 'desktop'),
    join(homedir(), '.dsh', 'profiles', 'desktop'),
  ]
  for (const candidate of candidates) {
    if (candidate === undefined) continue
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/** 可替换的依赖同步钩子：测试用临时 profile，没有真实 pnpm 环境，注入一个 no-op。 */
type SyncImplementation = (profile: string) => Promise<{ ok: boolean; detail: string }>
let syncImplementation: SyncImplementation = syncWithPnpm
export function setSyncImplementationForTest(fn: SyncImplementation): void {
  syncImplementation = fn
}

/**
 * 写完 package.json 后用 pnpm 同步 lockfile 与 node_modules。
 *
 * 这是「更新了却一直没生效」的真正原因：以前只改 profile 的 package.json，没碰
 * pnpm-lock.yaml。DSH 下次启动按 lockfile 装回旧版本 —— 用户看到的就是
 * 「一键更新从没成功过」。现在交给 pnpm 把 package.json / lockfile / node_modules
 * 三处一次对齐。失败时调用方会回滚 manifest：半更新的 profile 会让宿主 repair。
 */
async function syncWithPnpm(profile: string): Promise<{ ok: boolean; detail: string }> {
  return await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
    let child
    try {
      child = spawn(command, ['install', '--config.auto-install-peers=false', '--ignore-scripts'], {
        cwd: profile,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      })
    } catch (error: unknown) {
      resolve({ ok: false, detail: error instanceof Error ? error.message : String(error) })
      return
    }
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.on('error', (error: Error) => { resolve({ ok: false, detail: error.message }) })
    child.on('close', (code: number | null) => {
      if (code === 0) resolve({ ok: true, detail: 'pnpm install ok' })
      else resolve({ ok: false, detail: output.slice(-400) || `pnpm exit ${String(code)}` })
    })
  })
}

/** 一步的执行结果；id 和前端 UpdatePanel 的四步（下载 · 校验 · 备份数据 · 写入配置）一一对应。 */
export interface InstallStep {
  id: 'download' | 'verify' | 'backup' | 'write' | 'sync'
  ok: boolean
  detail?: string
}

/** What an install attempt produced. */
export interface InstallResult {
  ok: boolean
  /** The version written into the profile, when it landed. */
  version?: string
  /** Where the tarball was saved. */
  path?: string
  /** Whether a restart is needed for it to take effect. */
  restartRequired: boolean
  /** Why it did not land. */
  error?: string
  /** 更新前备份目录的绝对路径（备份成功后才有；里面的 restore.json 记着原 spec）。 */
  backupPath?: string
  /** 更新前正在运行的版本。 */
  previousVersion?: string
  /** 实际执行到的步骤，按执行顺序；没执行到的步骤不出现。 */
  steps?: InstallStep[]
}

/** 把下载 / 读写文件时的错误翻成一句中文（前端直接展示）。 */
function chineseFailure(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const name = error instanceof Error ? error.name : ''
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined
  const code = (error as { code?: unknown } | null)?.code ?? (cause as { code?: unknown } | null | undefined)?.code
  const codeText = typeof code === 'string' ? code : ''
  if (name === 'TimeoutError' || name === 'AbortError' || /timeout|timed out|aborted/iu.test(message)) {
    return `${prefix}：连接超时，请检查网络后重试`
  }
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|fetch failed|network/iu.test(`${codeText} ${message}`)) {
    return `${prefix}：连不上 npm（离线或代理没放行）`
  }
  if (codeText === 'EPERM' || codeText === 'EACCES' || codeText === 'EBUSY') {
    return `${prefix}：没有权限或文件被占用（可能被杀毒软件拦截）`
  }
  if (codeText === 'ENOSPC') return `${prefix}：磁盘空间不足`
  if (error instanceof SyntaxError) return `${prefix}：文件不是合法的 JSON`
  if (/[\u4e00-\u9fff]/u.test(message)) return `${prefix}：${message}`
  return `${prefix}（${message}）`
}

/** 只读地读 profile 的 package.json；读不了时返回中文原因。 */
function readProfilePackage(pkgPath: string): { pkg: Record<string, unknown> } | { error: string } {
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: `${pkgPath} 不是一个 JSON 对象，已取消更新` }
    }
    return { pkg: parsed as Record<string, unknown> }
  } catch (error: unknown) {
    return { error: chineseFailure('读取 profile 的 package.json 失败，已取消更新', error) }
  }
}

/**
 * 某个版本 tarball 的真实地址。
 *
 * 读 `/@refeain%2Fdsh-xdpool/<version>` 的 `dist.tarball`；读不到（网络失败、代理返回 HTML、
 * 版本元数据异常）时退回保底地址。**不**在这里把一个读不到当失败 —— 下载那一步会给出
 * 明确的 HTTP 状态，比「读元数据失败」更好诊断。
 */
export async function resolveTarballUrl(version: string): Promise<string> {
  try {
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(PACKAGE_NAME)}/${encodeURIComponent(version)}`,
      { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8_000) },
    )
    if (response.ok) {
      const meta = parseVersionMetadata(await response.json())
      if (meta !== undefined) return meta.tarball
    }
  } catch {
    // 落到保底地址。
  }
  return fallbackTarballUrl(version)
}

/**
 * Download a version and point the profile at it.
 *
 * The order matters, and it is the order the panel draws:
 *
 *   1. download — to a `.part` file, so a cut connection never leaves a plausible tarball;
 *   2. verify   — a gzip member starts with 1f 8b, which keeps a proxy's HTML page out;
 *   3. backup   — every data file this plugin (and its channel pack) owns is copied to
 *                 `<data dir>/pre-update/<old version>-<time>/`, with the old spec in
 *                 `restore.json` (see `pre-update-backup.ts`). A failed copy STOPS here;
 *   4. write    — only now is `package.json` touched.
 *
 * A failure at any step leaves the working install and its data exactly as they were.
 */
export async function installVersion(version: string): Promise<InstallResult> {
  const profile = profileDir()
  if (profile === undefined) {
    return {
      ok: false,
      restartRequired: false,
      previousVersion: POOL_VERSION,
      error: '找不到插件所在的 profile 目录，无法自动更新；请在 DSH 的插件设置里更新',
    }
  }
  /**
   * 同一个 profile 的更新合并成一次。
   *
   * `POST /plugins/dsh-xdpool/update` 是并发的 HTTP 入口：界面上那个 busy 只存在于某一个
   * 浏览器标签里，拦不住第二个标签、另一台机器、或者脚本连发两次。两个 installVersion
   * 同时跑同一个 profile 会互相踩 —— 双方都读到旧清单、各建一份备份、后成的那次把
   * node_modules 与 lockfile 交错写。这里让后来者直接等前一次的结果：
   * 一次更新只产生一份备份，写入与同步也不会交错。
   *
   * 队列里只留「正在进行的那一次」；结束即删，进程闲置时不留状态。
   */
  return await coalesceByProfile(profile, () => installIntoProfile(profile, version))
}

/** profile 目录（已归一化的绝对路径）→ 正在进行的更新。 */
const inFlightInstalls = new Map<string, Promise<InstallResult>>()

async function coalesceByProfile(
  profile: string,
  run: () => Promise<InstallResult>,
): Promise<InstallResult> {
  /**
   * 键要归一化。Windows 的文件系统不区分大小写，同一个 profile 在两个请求里可能一个写
   * `C:\Users\…\Desktop`、另一个写 `c:\users\…\desktop` —— 不折叠就把它们当成两个 profile，
   * 于是互斥形同虚设。
   */
  const absolute = resolve(profile)
  const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute
  const running = inFlightInstalls.get(key)
  if (running !== undefined) return await running
  let started: Promise<InstallResult>
  started = run().finally(() => {
    if (inFlightInstalls.get(key) === started) inFlightInstalls.delete(key)
  })
  inFlightInstalls.set(key, started)
  return await started
}

/** 真正做一次更新；只在 `coalesceByProfile` 的独占窗口里被调用。 */
async function installIntoProfile(profile: string, version: string): Promise<InstallResult> {
  const previousVersion = POOL_VERSION
  const steps: InstallStep[] = []
  const failed = (error: string, extra: { path?: string; backupPath?: string } = {}): InstallResult => ({
    ok: false,
    restartRequired: false,
    previousVersion,
    steps,
    error,
    ...extra,
  })
  /**
   * 临时文件必须独占：两个更新同时开始（或上一次的残留）会互相覆盖同一个 `.part`，
   * 结果是一个谁也没完整写过的 tar 包被当成新版本装上。mkdtemp 给出唯一目录，
   * 文件名只保留安全字符（scoped 包名里的 `/` 会造出不存在的子目录）。
   */
  const staging = mkdtempSync(join(tmpdir(), 'xdpool-update-'))
  const target = join(staging, `${packageFileStem()}-${version}.tgz`)
  const partial = `${target}.part`

  // 1. 下载
  try {
    /**
     * 先读这个版本的元数据，用其中的 `dist.tarball`。
     *
     * 拼地址的时代留下了两个坑：裸名 `dsh-xdpool` 指向的是另一个包；scoped 包的 tarball
     * 文件名不带 scope，凭名字猜很容易拼错。registry 自己给出的地址是唯一可信的那份，
     * 镜像 / 私有 registry 也会给出不同形状。读不到元数据时才退回约定的保底地址 —— 那是
     * 一个仍然正确、只是可能被镜像改写过的地址。
     */
    const tarballUrl = await resolveTarballUrl(version)
    const response = await fetch(tarballUrl, {
      signal: AbortSignal.timeout(120_000),
    })
    if (!response.ok || response.body === null) {
      steps.push({ id: 'download', ok: false, detail: `HTTP ${String(response.status)}` })
      return failed(`下载失败：服务器返回 HTTP ${String(response.status)}`)
    }
    mkdirSync(dirname(target), { recursive: true })
    const sink = createWriteStream(partial)
    // Streamed rather than buffered: the package is a few megabytes and there is no reason to
    // hold all of it to write it back out.
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      sink.write(chunk)
    }
    await new Promise<void>((resolve, reject) => {
      sink.end(() => { resolve() })
      sink.on('error', reject)
    })
    steps.push({ id: 'download', ok: true })
  } catch (error: unknown) {
    try { rmSync(partial, { force: true }) } catch { /* a stale .part is harmless */ }
    steps.push({ id: 'download', ok: false, detail: error instanceof Error ? error.message : String(error) })
    return failed(chineseFailure('下载新版本失败', error))
  }

  // 2. 校验 —— a gzip member starts with 1f 8b; this keeps a proxy's HTML error page from
  // being installed as a plugin.
  try {
    const head = readFileSync(partial).subarray(0, 2)
    if (head[0] !== 0x1f || head[1] !== 0x8b) {
      rmSync(partial, { force: true })
      steps.push({ id: 'verify', ok: false, detail: '不是 gzip 压缩包' })
      return failed('下载到的不是压缩包（可能被代理拦截）')
    }
    renameSync(partial, target)
    steps.push({ id: 'verify', ok: true })
  } catch (error: unknown) {
    steps.push({ id: 'verify', ok: false, detail: error instanceof Error ? error.message : String(error) })
    return failed(chineseFailure('校验安装包失败', error))
  }
  /**
   * The spec the profile gets: the plain version number.
   *
   * NOT `file:<the tarball we just downloaded>`. That made the market treat this
   * as a locally developed plugin (so it stopped offering updates), pointed the
   * profile at the OS temp directory (so a cleaner broke the next start), and let
   * the displayed version drift from the running bundle. See the module note.
   *
   * The download above already proved the registry is reachable and the package
   * is intact; after installing, pnpm's store holds the tarball, so a restart
   * does not go back to the network.
   */
  const newSpec = version

  // 3. 备份 —— 先只读地记下原来的 spec，再复制数据。这里任何失败都不碰 package.json。
  const pkgPath = join(profile, 'package.json')
  // pnpm 同步失败时回滚，避免留下「spec 新 / lockfile 旧」的不一致状态。
  const originalManifest = readFileSync(pkgPath, 'utf8')
  const read = readProfilePackage(pkgPath)
  if ('error' in read) {
    steps.push({ id: 'backup', ok: false, detail: read.error })
    return failed(read.error, { path: target })
  }
  const pkg = read.pkg
  /**
   * 在 profile 里找到本插件是哪一行的键。
   *
   * 现在的发布身份优先；找不到时退到旧裸名 —— 早期由写死裸名的 fork 安装过的 profile，那一行
   * 就叫 `dsh-xdpool`，不认它就没法从那个状态升上来。**同一依赖块里两个键同时存在**
   * 是历史误装的痕迹，此时不猜：两个都改会让回退说不清恢复成哪一行，直接报出需要人工处理。
   */
  const keysByBlock = resolveDependencyKeys(pkg)
  if ('conflict' in keysByBlock) {
    steps.push({ id: 'write', ok: false, detail: keysByBlock.conflict })
    return failed(keysByBlock.conflict, { path: target })
  }
  const previousSpecs: Record<string, string> = {}
  for (const block of DEPENDENCY_BLOCKS) {
    const key = keysByBlock.keys[block]
    if (key === undefined) continue
    const record = pkg[block]
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
    const spec = (record as Record<string, unknown>)[key]
    previousSpecs[block] = typeof spec === 'string' ? spec : JSON.stringify(spec)
  }
  if (Object.keys(previousSpecs).length === 0) {
    steps.push({ id: 'write', ok: false, detail: `package.json 里没有 ${PACKAGE_NAME}` })
    return failed(`profile 的 package.json 里没有 ${PACKAGE_NAME}，无法自动更新`, { path: target })
  }
  /**
   * 锁文件的快照必须在**任何东西被创建之前**取，并且读不出来就立刻停下。
   *
   * 两个理由：
   *   1. 快照是恢复阶段唯一的依据 —— 要决定「写回旧内容」还是「删掉它」。既然判断不出来，
   *      两种做法都可能破坏用户的安装状态（把存在的锁文件当不存在删掉，下次启动就换一套
   *      解析结果），所以宁可不更新。
   *   2. 放在建备份之前，失败时连一份新备份都不会留下，备份环也不会被 prune 挤掉一份旧备份。
   */
  const lockPath = join(profile, 'pnpm-lock.yaml')
  const lockBefore = snapshotFile(lockPath)
  if (lockBefore.kind === 'unreadable') {
    const reason = chineseFailure(
      '读不到 profile 的 pnpm-lock.yaml，已取消更新（文件没有被改动）',
      new Error(lockBefore.detail),
    )
    steps.push({ id: 'write', ok: false, detail: reason })
    return failed(reason, { path: target })
  }
  const backup = backupBeforeUpdate({
    profileDir: profile,
    previousVersion,
    targetVersion: version,
    previousSpecs,
    // 记下每一块原来用的是哪个键（可能是旧裸名），回退要写回同一行。
    previousKeys: Object.fromEntries(
      Object.entries(keysByBlock.keys).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    newSpec,
  })
  if (!backup.ok || backup.path === undefined) {
    const reason = backup.error ?? '更新前备份失败，已取消更新，插件和数据都没有改动'
    steps.push({ id: 'backup', ok: false, detail: reason })
    return failed(reason, { path: target })
  }
  const backupPath = backup.path
  steps.push({ id: 'backup', ok: true, detail: `${String(backup.manifest?.files ?? 0)} 个文件已备份到 ${backupPath}` })
  // 只保留最近几份；刚建的这一份无论如何都留着。删旧备份失败不影响这次更新。
  pruneOldBackups(preUpdateRoot(), undefined, backupPath)

  // 4. 写入 package.json —— staged through a sibling temp file, so a crash cannot leave the
  // profile with half a manifest (the backup holds the original either way).
  //
  // 恢复边界（交接文档 5.3）：只改回 package.json 是不够的 —— pnpm-lock.yaml 可能已经被
  // pnpm 写过一半，node_modules 也可能部分换过。锁文件的快照已在建备份之前取好（读不出来
  // 就不会走到这里），同步失败（返回失败**或抛异常**）都走同一条恢复路径，并分别记录
  // 每一处的恢复结果。
  try {
    /**
     * 写入规范包名，并把旧裸名那一行删掉。
     *
     * 只加不改是不够的：一个由旧 fork 装过的 profile 里留着 `dsh-xdpool` 那一行，再加一行
     * `@refeain/dsh-xdpool`，pnpm 会当成两个包各装一份 —— 一个是被 deprecate 的错包。
     * 旧键的原值已经记在 previousSpecs 里，回退时按它写回，所以这里删得掉也回得去。
     */
    for (const block of Object.keys(previousSpecs)) {
      const deps = pkg[block] as Record<string, unknown>
      const legacy = keysByBlock.keys[block]
      if (legacy !== undefined && legacy !== PACKAGE_NAME) delete deps[legacy]
      deps[PACKAGE_NAME] = newSpec
    }
    writeFileSync(`${pkgPath}.tmp`, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    renameSync(`${pkgPath}.tmp`, pkgPath)
    steps.push({ id: 'write', ok: true })

    /**
     * 关键：让 pnpm 同步 lockfile 与 node_modules。
     * 以前只到上一行就返回成功，DSH 下次启动按旧 lockfile 装回旧版，版本号从不变化。
     * 同步失败就回滚，宁可这次没更新，也不留下会触发宿主 repair 的半更新 profile。
     */
    let synced: { ok: boolean; detail: string }
    let syncThrew: unknown
    try {
      synced = await syncImplementation(profile)
    } catch (error: unknown) {
      // 钩子自己抛异常也是失败 —— 以前这个分支直接落到外层 catch，只报了「写入失败」，
      // 却没恢复已经改过的 package.json 与锁文件。
      syncThrew = error
      synced = { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
    if (!synced.ok) {
      const recovery = await recoverProfile({ pkgPath, originalManifest, lockPath, lockBefore, profile })
      const detail = syncThrew === undefined ? synced.detail : `同步钩子抛出异常：${synced.detail}`
      steps.push({ id: 'write', ok: false, detail: recovery.summary })
      if (!recovery.filesRestored) {
        // 文件都没恢复：不能说「清单与锁文件已恢复」，把没恢复的部分和修复入口一起交出来。
        return failed(
          `安装依赖失败（${detail}），且文件回滚未完成。${recovery.summary}。`
            + `profile 的备份在 ${backupPath}（restore.json 记着原 spec），可据此手动修复；`
            + '修好后重启 DSH 让宿主重新安装依赖',
          { path: target, backupPath },
        )
      }
      return failed(
        `安装依赖失败（${detail}）。package.json 与 pnpm-lock.yaml 已恢复成更新前的样子，`
          + '但 node_modules 在同步过程中可能已被部分改动 —— 这一点无法从插件侧确认。'
          + '再点一次「更新」可以重试；也可以直接重启 DSH，宿主会按写回的清单与锁文件把依赖装回去。',
        { path: target, backupPath },
      )
    }
    steps.push({ id: 'sync', ok: true, detail: synced.detail })
    return { ok: true, version, path: target, restartRequired: true, backupPath, previousVersion, steps }
  } catch (error: unknown) {
    // 写文件本身失败（磁盘满、权限、进程被杀）时也可能已经动过锁文件。
    const recovery = await recoverProfile({ pkgPath, originalManifest, lockPath, lockBefore, profile })
    const reason = chineseFailure('写入 profile 的 package.json 失败', error)
    steps.push({ id: 'write', ok: false, detail: `${reason}；${recovery.summary}` })
    if (!recovery.filesRestored) {
      return failed(
        `${reason}，且文件回滚未完成。${recovery.summary}。备份在 ${backupPath}（restore.json 记着原 spec），`
          + '可据此手动修复；修好后重启 DSH 让宿主重新安装依赖',
        { path: target, backupPath },
      )
    }
    return failed(
      `${reason}。${recovery.summary}；node_modules 未做同步，应当仍是更新前的样子，`
        + '但插件侧无法逐字节确认。重启 DSH 可让宿主按现有清单与锁文件重建依赖。',
      { path: target, backupPath },
    )
  }
}

/**
 * 一个文件在改动前的样子：内容 + 存不存在 + 读不读得出来。
 *
 * 只记内容不够 —— 原来没有这个文件、更新造出一个，回滚时就得删掉它，而不是写回空字符串。
 *
 * **读失败与不存在必须分开**。以前把任何读取异常都当成「文件不存在」，于是锁文件被
 * 杀毒软件锁住、或权限不足读不了的时候，恢复流程会认为「更新前没有锁文件」，
 * 直接把一个真实存在的 lockfile 删掉 —— 用户的下一个启动就变成了「按新的解析结果装依赖」。
 * 只有 ENOENT（含 ENOTDIR：路径中间不是目录，等效于不存在）才算真的不存在。
 */
type FileSnapshot =
  | { kind: 'missing' }
  | { kind: 'present'; content: string }
  | { kind: 'unreadable'; detail: string }

/** 读一个文件的内容与存在性；只有「确实不存在」才算不存在，其余读取错误原样报出来。 */
function snapshotFile(path: string): FileSnapshot {
  try {
    return { kind: 'present', content: readFileSync(path, 'utf8') }
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }
    return { kind: 'unreadable', detail: error instanceof Error ? error.message : String(error) }
  }
}

/** 把文件恢复成快照里的样子：原来有就写回原内容，原来没有就删掉。 */
function restoreFile(path: string, snapshot: FileSnapshot): { ok: boolean; detail?: string } {
  if (snapshot.kind === 'unreadable') {
    return { ok: false, detail: '更新前没能读出这个文件，无法判断该恢复成什么' }
  }
  try {
    if (snapshot.kind === 'present') {
      writeFileSync(`${path}.tmp`, snapshot.content, 'utf8')
      renameSync(`${path}.tmp`, path)
    } else {
      rmSync(path, { force: true })
    }
    return { ok: true }
  } catch (error: unknown) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

interface RecoverOptions {
  pkgPath: string
  originalManifest: string
  lockPath: string
  lockBefore: FileSnapshot
  profile: string
}

/**
 * 把 profile 恢复成更新前的样子，并如实报告结果。
 *
 * 恢复的是**可证明的那部分状态**：package.json 与锁文件的字节。顺序有理由 —— 先写回清单
 * （它是「安装了什么」的唯一声明），再写回锁文件（它决定下次启动装哪一版）。
 *
 * **不在这里重跑 pnpm 同步**，这一条是踩出来的：
 *   - 同步刚刚失败过，立刻重跑多半还是同一个原因（权限、占用、磁盘），只是让失败慢一倍；
 *   - 更糟的是它会**重新造出刚被删掉的文件** —— 更新前没有锁文件的 profile，恢复时删掉
 *     半成品锁文件，重跑同步又写回来，于是「回滚」之后仍留着一份来路不明的锁文件；
 *   - node_modules 的字节本来就不在可证明范围里，凭重跑来断言「依赖也回去了」是空头承诺。
 *
 * 下次 DSH 启动会按写回的锁文件重建依赖，那时状态自然一致。所以这里只承诺文件级恢复，
 * 并把 node_modules 的实际处境讲清楚，不假装它也是干净的。
 */
async function recoverProfile(options: RecoverOptions): Promise<{ filesRestored: boolean; summary: string }> {
  const notes: string[] = []
  let filesRestored = true

  const manifest = restoreFile(options.pkgPath, { kind: 'present', content: options.originalManifest })
  if (manifest.ok) notes.push('package.json 已写回')
  else { filesRestored = false; notes.push(`package.json 写回失败（${manifest.detail ?? '未知原因'}）`) }

  const lock = restoreFile(options.lockPath, options.lockBefore)
  if (lock.ok) {
    notes.push(options.lockBefore.kind === 'present' ? 'pnpm-lock.yaml 已写回' : 'pnpm-lock.yaml 已删除（更新前没有）')
  } else { filesRestored = false; notes.push(`pnpm-lock.yaml 恢复失败（${lock.detail ?? '未知原因'}）`) }

  return { filesRestored, summary: notes.join('；') }
}

/**
 * 在 profile 里找出本插件出现在哪些依赖块、用什么键。
 *
 * 返回的 `keys` 是「依赖块 -> 键名」。旧的裸名 profile 会给出 `dsh-xdpool`；同一块里同时
 * 出现两个键时返回 `conflict` —— 那是历史误装，两个都改会让回退说不清，必须人工选。
 */
export function resolveDependencyKeys(pkg: Record<string, unknown>): {
  keys: Record<string, string | undefined>
} | { conflict: string } {
  const keys: Record<string, string | undefined> = {}
  for (const block of DEPENDENCY_BLOCKS) {
    const record = pkg[block]
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
    const deps = record as Record<string, unknown>
    const present = KNOWN_PACKAGE_NAMES.filter(name => Object.hasOwn(deps, name))
    if (present.length > 1) {
      return {
        conflict: `profile 的 ${block} 里同时存在 ${KNOWN_PACKAGE_NAMES.join(' 和 ')}，`
          + '无法判断该更新哪一行；请先手动保留一个再更新',
      }
    }
    const only = present[0]
    if (only !== undefined) keys[block] = only
  }
  return { keys }
}

/**
 * Check, then install if there is something newer.
 *
 * Kept together so the route cannot install a version the check never saw — the alternative is a
 * caller passing an arbitrary version string to an endpoint that writes `package.json`.
 */
export async function updateToLatest(): Promise<InstallResult> {
  const status = await checkForUpdate({ force: true })
  if (status.error !== undefined) {
    return { ok: false, restartRequired: false, previousVersion: POOL_VERSION, error: chineseFailure('检查更新失败', new Error(status.error)) }
  }
  if (status.latest === undefined) {
    return { ok: false, restartRequired: false, previousVersion: POOL_VERSION, error: '检查更新失败：没有读到最新版本号' }
  }
  if (!status.newer) {
    return { ok: true, version: status.current, restartRequired: false }
  }
  return await installVersion(status.latest)
}
