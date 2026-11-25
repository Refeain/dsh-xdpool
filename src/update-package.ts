/**
 * 本插件的发布身份：一个地方说清楚「我们叫什么」。
 *
 * WHY THIS EXISTS
 *
 * 更新链路以前在三处各写了一个裸名 `dsh-xdpool`：查询 registry、拼 tarball 下载地址、
 * 写备份清单与回退键。包实际发布在 `@refeain/dsh-xdpool` 下，于是这三处一起去问一个
 * 不存在的裸名包 —— 查询永远读不到更新，备份把错的键写进 restore.json，回退也改不回来。
 *
 * 裸名不是纯粹的错：`dsh-xdpool` 是上游原名，早期由写死裸名的 fork 建出的 format=1 备份
 * 里记的就是它。所以这里同时导出两个身份，并明确它们各自的用途：
 *
 *   - `PACKAGE_NAME`       —— 现在的发布身份。查询、下载、写新备份、回退新备份都用它。
 *   - `LEGACY_PACKAGE_NAME` —— 旧备份里可能出现的裸名。只用于「读得懂旧备份」，绝不用于
 *                              拼新 URL 或写新键。
 *   - `KNOWN_PACKAGE_NAMES` —— 识别一份备份属于本插件时的候选集合。
 *
 * 身份从 `package.json` 读，而不是再写一遍常量：源码测试里它就在旁边；构建后的宿主入口
 * 由 tsdown 打成单文件，读不到时退回这里的默认值。两条路都指向同一个名字，
 * `tests/update-identity.test.ts` 盯着这个一致。
 *
 * @module dsh-xdpool/update-package
 */
import { readFileSync } from 'node:fs'

/** 上游原名，也是旧 format=1 备份里可能出现的名字。 */
export const LEGACY_PACKAGE_NAME = 'dsh-xdpool'

/**
 * 兜底：与仓库 `package.json` 的 `name` 一致，构建后读不到清单时用它。
 *
 * 导出是为了让测试能断言「兜底值就是真实包名」—— 这条如果退化成裸名，构建产物里的更新
 * 检查就又会去问另一个包，而那种错误在运行时不报任何异常。
 */
export const FALLBACK_PACKAGE_NAME = '@refeain/dsh-xdpool'

/**
 * 从相邻的 `package.json` 读包名。
 *
 * 只在启动时读一次。读不到（构建产物里没有清单）、读坏了、或者读出来的不是本插件可选的名字，
 * 都退回兜底值 —— 更新功能不能用「读不到名字」当理由整个失效。
 */
function readPackageName(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { name?: unknown }
    const name = manifest.name
    if (typeof name === 'string' && name !== '') return name
  } catch {
    // 构建后的单文件里没有这个清单；兜底值是正确的那个。
  }
  return FALLBACK_PACKAGE_NAME
}

/** 现在的发布身份，例如 `@refeain/dsh-xdpool`。查询、下载、写新备份都用它。 */
export const PACKAGE_NAME: string = readPackageName()

/** 识别一份备份是否属于本插件时可接受的名字；新的在前。 */
export const KNOWN_PACKAGE_NAMES: readonly string[] = PACKAGE_NAME === LEGACY_PACKAGE_NAME
  ? [PACKAGE_NAME]
  : [PACKAGE_NAME, LEGACY_PACKAGE_NAME]

/**
 * 把一个包名安全地用作文件名 / 目录名。
 *
 * scoped 包名里的斜杠会把 `join(tmpdir(), name)` 变成一层不存在的子目录，所以 `/` 换成 `+`
 * 之后再做一次白名单收紧。`@refeain/dsh-xdpool` -> `@refeain+dsh-xdpool`。
 */
export function packageFileStem(name: string = PACKAGE_NAME): string {
  return name.replaceAll('/', '+').replace(/[^A-Za-z0-9@._+-]/gu, '_')
}

/**
 * registry 上某个版本的 tarball 保底地址。
 *
 * npm 的约定是 scoped 包的 tarball 文件名不带 scope：`@refeain/dsh-xdpool` 的 3.3.0 落在
 * `.../@refeain/dsh-xdpool/-/dsh-xdpool-3.3.0.tgz`。这只是保底 —— 正常路径是读版本元数据里的
 * `dist.tarball`，因为镜像或私有 registry 会给出别的形状。
 */
export function fallbackTarballUrl(version: string, name: string = PACKAGE_NAME): string {
  const unscoped = name.startsWith('@') ? (name.split('/')[1] ?? name) : name
  return `https://registry.npmjs.org/${name}/-/${unscoped}-${version}.tgz`
}

/** registry 上某个版本的元数据，本模块只关心下载要用的两样。 */
export interface VersionMetadata {
  /** 这个版本的 tarball 绝对地址。 */
  tarball: string
  /** 这个版本发布时间，ISO，registry 给了才有。 */
  publishedAt?: string
}

/**
 * 从 registry 的版本文档里读 `dist.tarball`。
 *
 * `metadata` 是 `/@refeain%2Fdsh-xdpool/3.3.0` 的响应体。读不到就返回 undefined，由调用方
 * 决定退到保底地址还是直接报错 —— 这里不编一个地址出来。
 */
export function parseVersionMetadata(metadata: unknown): VersionMetadata | undefined {
  if (metadata === null || typeof metadata !== 'object') return undefined
  const record = metadata as Record<string, unknown>
  const dist = record['dist']
  if (dist === null || typeof dist !== 'object') return undefined
  const tarball = (dist as Record<string, unknown>)['tarball']
  if (typeof tarball !== 'string' || tarball === '') return undefined
  const time = record['time']
  const publishedAt = typeof time === 'string' && time !== '' ? time : undefined
  return { tarball, ...(publishedAt === undefined ? {} : { publishedAt }) }
}
