/**
 * 更新前自动备份，以及回退。
 *
 * WHY
 *
 * 自动更新只改 profile 的 package.json，但新版本一启动就会读、迁移、再写插件的数据文件。
 * 新版本万一读错了一个字段，下一次保存就把用户的 API Key、账号、路由链写坏 —— 而这些都是
 * 用户自己的凭据，没有任何上游能还给他。所以在动 package.json 之前，先把插件的全部数据
 * 原样复制一份，再把原来的 dsh-xdpool spec 记下来，这样任何时候都能回到更新前的样子。
 *
 * 备份了什么（只复制存在的；一律原样复制，不解析、不改写）：
 *
 *   xdpool/            <DSH home>/.xdpool —— 插件自己的数据目录：aggregate.json（API Key、
 *                      路由链、局域网网关）、accounts.json（账号池凭据）、ignored.json、
 *                      preferred.json、sticky-affinity.json、channel-usage.json、各渠道会话
 *                      （doubao-session(s).json、marvis/astudio/monkeycode/baizhi/autoclaw/
 *                      accio/magicrew…-accounts.json）、导入的 *.info 快照、backups/、
 *                      startup.log。跳过 pre-update/（备份自己）和 login-profiles/（临时
 *                      浏览器配置，几十上百 MB，且每次登录都会重建）。
 *   home-xdpool/       DSH_HOME 未设置时 aggregate.json 写在 ~/.xdpool 而不是 ~/.dsh/.xdpool
 *                      （store.ts 一直如此），两处不同时这一份也备份。
 *   workbuddy-xdpool/  改名前的旧数据目录（若还在）。
 *   channel-pack@…/    channel-pack 的状态目录：state.json（扫码登录的账号）、token-ledger.json
 *                      （用量账本）、dead-models.json（模型黑名单）、permanent-locks.json、
 *                      auto-checkin.json、ui-preferences.json 等。pack 的根目录可能是
 *                      DSH_CHANNEL_PACK_STATE_DIR、profile 目录或 DSH home，存在的都备份。
 *   profile/           profile 的 package.json，以及宿主的 settings 文档（settings.yaml 等，
 *                      插件设置里的 automation、automationEarnings、creditReserves、模型选择
 *                      都在这里）和 cordis.patch.yml。
 *   previous-package/  更新前 spec 指向的本地 .tgz（若是 file: 且文件还在）—— 它通常在
 *                      %TEMP% 里，随时可能被清理，复制一份回退才靠得住。
 *
 * 不在备份里的：浏览器侧的 localStorage / IndexedDB（xdpool.tab、渠道计数缓存、豆包模型
 * 开关、备份历史），Node 侧碰不到；豆包的浏览器配置目录 ~/.dsh/doubao-browser-profile
 * （Chrome 配置，太大，且会话本身已在 doubao-session(s).json 里）。
 *
 * 备份放在 <插件数据目录>/pre-update/<旧版本>-<时间戳>/，和数据同一个根目录，只保留最近
 * {@link PRE_UPDATE_KEEP} 份。目录里的 restore.json 记录原 spec、旧版本号、时间和每一份
 * 数据原来在哪；回退说明.txt 是给人看的同一份信息。
 *
 * @module dsh-xdpool/pre-update-backup
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { KNOWN_PACKAGE_NAMES, LEGACY_PACKAGE_NAME, PACKAGE_NAME } from './update-package.ts'

/** 备份根目录名，位于插件数据目录下。 */
export const PRE_UPDATE_DIR_NAME = 'pre-update'
/** 只保留最近几份。 */
export const PRE_UPDATE_KEEP = 5
/** 机器读的回退信息。 */
export const RESTORE_FILE_NAME = 'restore.json'
/** 人读的回退说明。 */
export const ROLLBACK_NOTE_NAME = '回退说明.txt'
/** package.json 里可能出现本插件的依赖块。 */
export const DEPENDENCY_BLOCKS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const

/** 插件数据目录顶层不进备份的条目。 */
const SKIP_TOP_LEVEL: ReadonlySet<string> = new Set([PRE_UPDATE_DIR_NAME, 'login-profiles'])
/**
 * profile 目录里要备份的文件。
 *
 * 锁文件必须在内：更新会写 package.json 并让 pnpm 重写 pnpm-lock.yaml，恢复时不能只回退
 * 清单 —— 一份新清单配一份旧锁文件正是「更新了却没有生效」的那个状态。回退要能把两者
 * 一起还原，首先得有一份保存下来的锁文件。
 */
const PROFILE_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'settings.yaml',
  'settings.yml',
  'settings.json',
  'cordis.patch.yml',
] as const

/** 一份数据：原来在哪，备份到哪。 */
export interface BackupEntry {
  label: string
  from: string
  to: string
  files: number
  bytes: number
}

/** restore.json 的内容。 */
export interface RestoreManifest {
  /**
   * 备份时本插件在 profile 里的包名。
   *
   * 新备份写现在的发布身份（`@refeain/dsh-xdpool`）；旧 format=1 备份由写死裸名的 fork 创建，
   * 这里可能是 `dsh-xdpool`。读取时两者都接受，写新备份时只用规范名。
   */
  package: string
  format: 1
  createdAt: string
  previousVersion: string
  targetVersion: string
  profileDir: string
  packageJsonPath: string
  /** 更新前本插件的 spec（第一处依赖块里的）。 */
  previousSpec?: string
  /** 每个依赖块各自的原 spec。 */
  previousSpecs: Record<string, string>
  /**
   * 依赖块 -> 更新前用的键名。
   *
   * 旧备份没有这个字段，那时键就是 `package`。回退必须写回**原来那一行的键**：一个从
   * 裸名装过来的 profile，回退时写回 `@refeain/…` 会装出一个它原来没有的依赖。
   */
  previousKeys?: Record<string, string>
  /** 将要写入的新 spec。 */
  newSpec?: string
  /** 回退时写回 package.json 的 spec：优先用备份里那份 .tgz，没有就用原 spec。 */
  rollbackSpec?: string
  /** 备份里那份旧 .tgz 的绝对路径。 */
  previousTarball?: string
  entries: BackupEntry[]
  files: number
  bytes: number
}

export interface PreUpdateBackupOptions {
  /** profile 目录（package.json 所在）。 */
  profileDir: string
  previousVersion: string
  targetVersion: string
  /** 依赖块 -> 原 spec。 */
  previousSpecs: Readonly<Record<string, string>>
  /**
   * 依赖块 -> 更新前用的键名。
   *
   * 省略时按规范包名推断（新备份的常态）。旧裸名 profile 会在更新时迁到规范名，
   * 这里必须记下原来那行叫 `dsh-xdpool`，回退才能写回同一行而不是造出一行新的。
   */
  previousKeys?: Readonly<Record<string, string>>
  newSpec?: string
  env?: NodeJS.ProcessEnv
  /** 用户主目录，测试用。 */
  home?: string
  now?: Date
}

export interface PreUpdateBackupResult {
  ok: boolean
  /** 备份目录的绝对路径。 */
  path?: string
  manifest?: RestoreManifest
  /** 中文原因。 */
  error?: string
}

/** 和 ignored.ts 的 dshHome 同一规则，但主目录可注入。 */
function dshHomeOf(env: NodeJS.ProcessEnv, home: string): string {
  const fromEnv = env['DSH_HOME']
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(home, '.dsh')
}

/** 插件数据目录（和 ignored.ts 的 pluginDataDir 相同）。 */
export function backupDataDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(dshHomeOf(env, home), '.xdpool')
}

/** 备份根目录。 */
export function preUpdateRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(backupDataDir(env, home), PRE_UPDATE_DIR_NAME)
}

/** 要备份的来源，按顺序，已去重、只含存在的。 */
export function backupSources(
  profileDir: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): { label: string; from: string; kind: 'data' | 'dir' | 'profile' }[] {
  const out: { label: string; from: string; kind: 'data' | 'dir' | 'profile' }[] = []
  const seen = new Set<string>()
  const add = (label: string, from: string, kind: 'data' | 'dir' | 'profile'): void => {
    const key = resolve(from).toLowerCase()
    if (seen.has(key)) return
    if (!existsSync(from)) return
    seen.add(key)
    out.push({ label, from, kind })
  }
  const dsh = dshHomeOf(env, home)
  add('xdpool', join(dsh, '.xdpool'), 'data')
  // store.ts：`env.DSH_HOME ?? homedir()` —— DSH_HOME 未设置时是 ~/.xdpool，不是 ~/.dsh/.xdpool。
  const aggregateHome = env['DSH_HOME'] ?? home
  if (aggregateHome !== '') add('home-xdpool', join(aggregateHome, '.xdpool'), 'data')
  add('workbuddy-xdpool', join(dsh, '.workbuddy-xdpool'), 'dir')
  const packOverride = env['DSH_CHANNEL_PACK_STATE_DIR']
  if (typeof packOverride === 'string' && packOverride.trim() !== '') {
    add('channel-pack@state-dir', join(packOverride.trim(), 'channel-pack'), 'dir')
  }
  add('channel-pack@profile', join(profileDir, 'channel-pack'), 'dir')
  add('channel-pack@dsh-home', join(dsh, 'channel-pack'), 'dir')
  add('profile', profileDir, 'profile')
  return out
}

/** 把一个错误翻成一句中文。 */
export function describeFsError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'ENOSPC': return '磁盘空间不足'
    case 'EPERM':
    case 'EACCES': return '没有写入权限（可能被杀毒软件拦截）'
    case 'EBUSY': return '文件被其他程序占用'
    case 'ENOTDIR':
    case 'EEXIST': return '备份位置被同名文件占用'
    case 'ENOENT': return '文件在复制过程中消失了'
    case 'EMFILE': return '打开的文件太多'
    default: break
  }
  if (/[\u4e00-\u9fff]/u.test(message)) return message
  return `文件操作失败（${message}）`
}

interface CopyTally { files: number; bytes: number }

/**
 * 递归复制，逐个文件核对大小。跳过符号链接和写到一半的 *.tmp / *.part。
 * `skipTop` 只作用于最顶层。
 */
function copyTree(from: string, to: string, tally: CopyTally, skipTop: ReadonlySet<string>): void {
  mkdirSync(to, { recursive: true, mode: 0o700 })
  for (const name of readdirSync(from)) {
    if (skipTop.has(name)) continue
    if (name.endsWith('.tmp') || name.endsWith('.part')) continue
    const source = join(from, name)
    const target = join(to, name)
    const info = lstatSync(source)
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      copyTree(source, target, tally, new Set<string>())
      continue
    }
    if (!info.isFile()) continue
    copyFile(source, target, tally)
  }
}

function copyFile(source: string, target: string, tally: CopyTally): void {
  copyFileSync(source, target)
  const want = statSync(source).size
  const got = statSync(target).size
  if (want !== got) throw new Error(`复制后大小不一致：${source}`)
  tally.files += 1
  tally.bytes += got
}

/** `2026-11-22T04-37-00-123Z`：能当目录名，按字典序就是时间序。 */
function stampOf(now: Date): string {
  return now.toISOString().replace(/[:.]/gu, '-')
}

/** 版本号里只留能进目录名的字符。 */
function safeSegment(text: string): string {
  const cleaned = text.replace(/[^0-9A-Za-z._-]+/gu, '_').slice(0, 64)
  return cleaned === '' ? 'unknown' : cleaned
}

/** `file:` spec 指向的本地路径；不是本地 .tgz 时 undefined。 */
function localTarballOf(spec: string | undefined, profileDir: string): string | undefined {
  if (spec === undefined || !spec.startsWith('file:')) return undefined
  let path = spec.slice('file:'.length)
  if (path.startsWith('//')) path = path.slice(2)
  // `file:/C:/…` 在 Windows 上要去掉开头那个斜杠。
  if (/^\/[A-Za-z]:[\\/]/u.test(path)) path = path.slice(1)
  if (!/\.(tgz|tar\.gz)$/iu.test(path)) return undefined
  const absolute = resolve(profileDir, path)
  try {
    return statSync(absolute).isFile() ? absolute : undefined
  } catch {
    return undefined
  }
}

function rollbackNote(manifest: RestoreManifest, dir: string): string {
  // 用备份里记的那一行键名：旧备份是裸名，新备份是 scoped 名。写错名字用户改不动。
  const key = manifestKey(manifest)
  const lines = [
    `XD Pool 更新前备份`,
    ``,
    `创建时间：${manifest.createdAt}`,
    `更新前版本：${manifest.previousVersion}`,
    `准备更新到：${manifest.targetVersion}`,
    `profile 的 package.json：${manifest.packageJsonPath}`,
    `更新前的 ${key} spec：${manifest.previousSpec ?? '（未记录）'}`,
    ``,
    `—— 回退到更新前的版本 ——`,
    `1. 完全退出 DSH。`,
    `2. 打开 ${manifest.packageJsonPath}，把 "${key}" 那一行的值改回：`,
    `     ${manifest.rollbackSpec ?? manifest.previousSpec ?? '（见 restore.json）'}`,
    `   （或者直接用本目录 profile\\package.json 覆盖它。）`,
    `3. 重新打开 DSH。`,
    ``,
    `—— 需要连数据一起恢复时（一般不需要）——`,
    `先完全退出 DSH，再把下面每个子目录里的内容复制回原位置（覆盖前建议先把原位置另存一份）：`,
  ]
  for (const entry of manifest.entries) {
    lines.push(`   ${join(dir, entry.label)}  ->  ${entry.from}`)
  }
  lines.push('', '本目录由插件自动创建，只保留最近 5 份；要长期保留请复制到别处。', '')
  return lines.join('\r\n')
}

/**
 * 在改 package.json 之前把插件数据完整复制一份。
 *
 * 任何一步失败都返回 ok:false 和中文原因，并删除这次写了一半的备份目录（只删自己刚建的
 * 那个目录，别的什么都不碰）。成功时 restore.json 和回退说明.txt 已落盘。
 */
export function backupBeforeUpdate(options: PreUpdateBackupOptions): PreUpdateBackupResult {
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const now = options.now ?? new Date()
  const root = preUpdateRoot(env, home)
  const base = join(root, `${safeSegment(options.previousVersion)}-${stampOf(now)}`)
  let dir = base
  for (let attempt = 2; existsSync(dir); attempt += 1) dir = `${base}-${String(attempt)}`
  const fail = (stage: string, error: unknown): PreUpdateBackupResult => {
    try {
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响结论：更新已经取消。
    }
    return { ok: false, error: `更新前备份失败（${stage}：${describeFsError(error)}），已取消更新，插件和数据都没有改动` }
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  } catch (error: unknown) {
    return fail(`创建备份目录 ${dir}`, error)
  }
  const entries: BackupEntry[] = []
  const total: CopyTally = { files: 0, bytes: 0 }
  for (const source of backupSources(options.profileDir, env, home)) {
    const to = join(dir, source.label)
    const tally: CopyTally = { files: 0, bytes: 0 }
    try {
      if (source.kind === 'profile') {
        mkdirSync(to, { recursive: true, mode: 0o700 })
        for (const name of PROFILE_FILES) {
          const file = join(source.from, name)
          if (existsSync(file) && statSync(file).isFile()) copyFile(file, join(to, name), tally)
        }
      } else {
        copyTree(source.from, to, tally, source.kind === 'data' ? SKIP_TOP_LEVEL : new Set<string>())
      }
    } catch (error: unknown) {
      return fail(`复制 ${source.from}`, error)
    }
    entries.push({ label: source.label, from: source.from, to, files: tally.files, bytes: tally.bytes })
    total.files += tally.files
    total.bytes += tally.bytes
  }
  const specs: Record<string, string> = { ...options.previousSpecs }
  const firstBlock = DEPENDENCY_BLOCKS.find(block => specs[block] !== undefined)
  const previousSpec = firstBlock === undefined ? undefined : specs[firstBlock]
  let previousTarball: string | undefined
  const tarball = localTarballOf(previousSpec, options.profileDir)
  if (tarball !== undefined) {
    const to = join(dir, 'previous-package')
    try {
      mkdirSync(to, { recursive: true, mode: 0o700 })
      const tally: CopyTally = { files: 0, bytes: 0 }
      previousTarball = join(to, basename(tarball))
      copyFile(tarball, previousTarball, tally)
      entries.push({ label: 'previous-package', from: tarball, to: previousTarball, files: tally.files, bytes: tally.bytes })
      total.files += tally.files
      total.bytes += tally.bytes
    } catch (error: unknown) {
      return fail(`复制旧安装包 ${tarball}`, error)
    }
  }
  const manifest: RestoreManifest = {
    package: PACKAGE_NAME,
    format: 1,
    createdAt: now.toISOString(),
    previousVersion: options.previousVersion,
    targetVersion: options.targetVersion,
    profileDir: options.profileDir,
    packageJsonPath: join(options.profileDir, 'package.json'),
    ...(previousSpec === undefined ? {} : { previousSpec }),
    previousSpecs: specs,
    ...(options.previousKeys === undefined ? {} : { previousKeys: { ...options.previousKeys } }),
    ...(options.newSpec === undefined ? {} : { newSpec: options.newSpec }),
    ...(previousTarball !== undefined
      ? { rollbackSpec: `file:${previousTarball.replaceAll('\\', '/')}`, previousTarball }
      : previousSpec === undefined ? {} : { rollbackSpec: previousSpec }),
    entries,
    files: total.files,
    bytes: total.bytes,
  }
  try {
    const restorePath = join(dir, RESTORE_FILE_NAME)
    writeFileSync(`${restorePath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    renameSync(`${restorePath}.tmp`, restorePath)
    writeFileSync(join(dir, ROLLBACK_NOTE_NAME), rollbackNote(manifest, dir), 'utf8')
    // 读回来确认真的落盘了 —— 回退全靠这一份。
    const check = JSON.parse(readFileSync(restorePath, 'utf8')) as Partial<RestoreManifest>
    if (check.previousVersion !== manifest.previousVersion) throw new Error('restore.json 读回内容不一致')
  } catch (error: unknown) {
    return fail('写入 restore.json', error)
  }
  return { ok: true, path: dir, manifest }
}

/** 备份清单里记的本插件名字；缺失时按现在的发布身份。 */
export function manifestKey(manifest: Partial<RestoreManifest>): string {
  return typeof manifest.package === 'string' && manifest.package !== '' ? manifest.package : PACKAGE_NAME
}

/**
 * 认出一份备份在 profile 里用的是哪一行键。
 *
 * 为什么不能只看 `manifest.package`：旧备份由写死裸名的 fork 建，也可能是某个 fork 把它误标成
 * 自己的名字。真正的证据是备份里那份**原 profile 的 package.json** —— 它记着当时依赖到底
 * 写在哪个键上。
 *
 * 判定顺序：
 *   1. 备份里的 profile/package.json：每个依赖块里只出现一个已知名字 -> 就是那个键；
 *   2. 同一块里同时出现两个已知名字 -> 冲突，交给人工选，不猜；
 *   3. 那份清单里找不到本插件 -> 退回 `manifest.package`（fork 可能改了键名）；
 *   4. 连 `manifest.package` 都没有 -> 无法判定。
 */
export interface BackupIdentity {
  /** 依赖块 -> 键名。判定失败时为空。 */
  keys: Record<string, string>
  /** 判定失败时的中文原因。 */
  problem?: string
}

/** 从备份里的原 profile 清单和 restore.json 推断依赖键。 */
export function identifyBackup(backupDir: string, manifest: Partial<RestoreManifest>): BackupIdentity {
  const specs = manifest.previousSpecs
  const blocks = specs !== null && typeof specs === 'object'
    ? DEPENDENCY_BLOCKS.filter(block => typeof (specs as Record<string, unknown>)[block] === 'string')
    : []
  const recorded = manifestKey(manifest)

  let original: Record<string, unknown> | undefined
  try {
    const parsed = JSON.parse(readFileSync(join(backupDir, 'profile', 'package.json'), 'utf8')) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      original = parsed as Record<string, unknown>
    }
  } catch {
    // 旧备份不一定存了 profile 清单（PROFILE_FILES 后来才补全），不算错。
  }

  const keys: Record<string, string> = {}
  for (const block of blocks) {
    let found: string[] = []
    if (original !== undefined) {
      const record = original[block]
      if (record !== null && typeof record === 'object' && !Array.isArray(record)) {
        const deps = record as Record<string, unknown>
        found = KNOWN_PACKAGE_NAMES.filter(name => Object.hasOwn(deps, name))
      }
    }
    if (found.length > 1) {
      return {
        keys: {},
        problem: `备份里 ${block} 同时存在 ${found.join(' 和 ')}，无法判断原来装的是哪一行；`
          + '请打开备份里的 profile/package.json 确认后手动改回，再重启 DSH',
      }
    }
    // 原清单里没有这一行（旧备份没存清单，或 fork 改了键名）时按记录的名字来。
    keys[block] = found[0] ?? recorded
  }
  if (blocks.length === 0) {
    return { keys: {}, problem: 'restore.json 里没有记录本插件原来的 spec，无法回退' }
  }
  return { keys }
}
export interface PreUpdateBackupInfo {
  path: string
  createdAt: string
  previousVersion: string
  targetVersion: string
  previousSpec?: string
}

/** 列出备份根目录下的备份（只认带 restore.json 的目录），新的在前。永不抛错。 */
export function listPreUpdateBackups(root: string): PreUpdateBackupInfo[] {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const out: (PreUpdateBackupInfo & { sortKey: number })[] = []
  for (const name of names) {
    const path = join(root, name)
    try {
      if (!statSync(path).isDirectory()) continue
      const manifest = JSON.parse(readFileSync(join(path, RESTORE_FILE_NAME), 'utf8')) as Partial<RestoreManifest>
      // 认旧备份：写死裸名的 fork 建的备份里 package 是 `dsh-xdpool`，那也是本插件的备份。
      if (!KNOWN_PACKAGE_NAMES.includes(manifestKey(manifest))) continue
      const createdAt = typeof manifest.createdAt === 'string' ? manifest.createdAt : ''
      const parsed = Date.parse(createdAt)
      out.push({
        path,
        createdAt,
        previousVersion: typeof manifest.previousVersion === 'string' ? manifest.previousVersion : '',
        targetVersion: typeof manifest.targetVersion === 'string' ? manifest.targetVersion : '',
        ...(typeof manifest.previousSpec === 'string' ? { previousSpec: manifest.previousSpec } : {}),
        sortKey: Number.isNaN(parsed) ? statSync(path).mtimeMs : parsed,
      })
    } catch {
      // 不是我们的目录，或者 restore.json 坏了：不列出，也绝不删除。
    }
  }
  out.sort((a, b) => b.sortKey - a.sortKey || (a.path < b.path ? 1 : a.path > b.path ? -1 : 0))
  return out.map(({ sortKey: _sortKey, ...info }) => info)
}

/**
 * 只保留最近 `keep` 份备份，返回删掉的目录。
 *
 * 只删带合法 restore.json 的目录（我们自己建的）；用户放进来的其他东西一律不碰。永不抛错。
 * `keepPath`（通常是刚建好的那一份）无论排第几都不删。
 */
export function pruneOldBackups(root: string, keep: number = PRE_UPDATE_KEEP, keepPath?: string): string[] {
  const removed: string[] = []
  const protectedKey = keepPath === undefined ? undefined : resolve(keepPath).toLowerCase()
  const backups = listPreUpdateBackups(root)
  const pinned = backups.filter(backup => resolve(backup.path).toLowerCase() === protectedKey)
  const others = backups.filter(backup => resolve(backup.path).toLowerCase() !== protectedKey)
  const room = Math.max(0, keep - pinned.length)
  for (const backup of others.slice(room)) {
    try {
      rmSync(backup.path, { recursive: true, force: true })
      removed.push(backup.path)
    } catch {
      // 删不掉就留着，下次再试。
    }
  }
  return removed
}

/** 回退的结果。 */
export interface RollbackResult {
  ok: boolean
  /** 写回 package.json 的 spec。 */
  spec?: string
  restartRequired: boolean
  error?: string
}

/**
 * 按备份目录里的 restore.json 把 profile 的 package.json 改回更新前的 spec。
 *
 * 只改 spec，不动任何数据文件 —— 数据要不要恢复由用户自己决定（见回退说明.txt），
 * 自动覆盖正在用的数据比不恢复更危险。需要重启 DSH 才生效。
 */
export function rollbackPackageSpec(backupDir: string): RollbackResult {
  let manifest: Partial<RestoreManifest>
  try {
    manifest = JSON.parse(readFileSync(join(backupDir, RESTORE_FILE_NAME), 'utf8')) as Partial<RestoreManifest>
  } catch {
    return { ok: false, restartRequired: false, error: `读不到 ${join(backupDir, RESTORE_FILE_NAME)}，无法回退` }
  }
  const specs = manifest.previousSpecs
  const pkgPath = manifest.packageJsonPath
  if (specs === undefined || specs === null || typeof specs !== 'object' || typeof pkgPath !== 'string') {
    return { ok: false, restartRequired: false, error: 'restore.json 缺少原来的 spec 或 package.json 路径，无法回退' }
  }
  const rollbackSpec = typeof manifest.rollbackSpec === 'string' ? manifest.rollbackSpec : undefined
  const previousTarball = typeof manifest.previousTarball === 'string' ? manifest.previousTarball : undefined
  // 备份里的旧 .tgz 还在就用它（原 spec 可能指向已被清理的 %TEMP%）。
  const useTarball = rollbackSpec !== undefined && previousTarball !== undefined && existsSync(previousTarball)
  /**
   * 写回**原来那一行的键**，而不是当前常量。
   *
   * 一个由旧裸名装过来的 profile，回退时写成 `@refeain/dsh-xdpool` 会装出一个它原来没有的
   * 依赖；反过来，一个 scoped 的 profile 回退成裸名会让 pnpm 去装那个被 deprecate 的错包。
   * 键从哪里来：新备份记了 previousKeys；旧备份没有这个字段，就从备份里的原 profile 清单
   * 反推（见 identifyBackup）。判定不出来时**不猜**：把备份列出来，请用户手选。
   */
  const identity = identifyBackup(backupDir, manifest)
  if (identity.problem !== undefined) {
    return { ok: false, restartRequired: false, error: identity.problem }
  }
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    let written: string | undefined
    for (const block of DEPENDENCY_BLOCKS) {
      const original = (specs as Record<string, unknown>)[block]
      if (typeof original !== 'string') continue
      const key = identity.keys[block] ?? manifestKey(manifest)
      const current = pkg[block]
      const record: Record<string, unknown> = current !== null && typeof current === 'object' && !Array.isArray(current)
        ? current as Record<string, unknown>
        : {}
      const spec = useTarball && rollbackSpec !== undefined ? rollbackSpec : original
      /**
       * 回退是「回到装之前的样子」：更新时迁到规范名的那一行要删掉，原来那行写回去。
       * 只在规范名和原键不同（确实是迁移过来的）时才删，否则会把刚写的那行删掉。
       */
      if (key !== PACKAGE_NAME) delete record[PACKAGE_NAME]
      record[key] = spec
      pkg[block] = record
      written ??= spec
    }
    if (written === undefined) {
      return { ok: false, restartRequired: false, error: 'restore.json 里没有记录本插件原来的 spec，无法回退' }
    }
    writeFileSync(`${pkgPath}.tmp`, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    renameSync(`${pkgPath}.tmp`, pkgPath)
    return { ok: true, spec: written, restartRequired: true }
  } catch (error: unknown) {
    return { ok: false, restartRequired: false, error: `回退失败：${describeFsError(error)}` }
  }
}
