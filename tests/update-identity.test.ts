/**
 * 发布身份的守卫：这三条不是「多测一遍」，它们守的是 F1 本身。
 *
 * 缺陷是「三处各写一个裸名 `dsh-xdpool`」造成的，而裸名在 npm 上**确实存在**（那是别人维护
 * 的 3.0.x）。这意味着把它改回裸名之后，代码照样能跑通、接口照样有响应、看起来一切正常 ——
 * 只是问的不是这个包。所以这里断言的是**具体的字符串形状**，不是「有没有返回版本号」。
 *
 * 把实现改回裸名时，这个文件必须变红。任何一条不红，说明它测的是别的东西。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { checkForUpdate } from '../src/update-check.ts'
import { resolveTarballUrl } from '../src/update-install.ts'
import {
  FALLBACK_PACKAGE_NAME as FALLBACK_NAME,
  KNOWN_PACKAGE_NAMES,
  LEGACY_PACKAGE_NAME,
  PACKAGE_NAME,
  packageFileStem,
  parseVersionMetadata,
  fallbackTarballUrl,
} from '../src/update-package.ts'

/** 每次用例都要能绕过 10 分钟的缓存。 */
beforeEach(() => {
  vi.unstubAllGlobals()
})

/** 抓住 checkForUpdate 实际请求的 URL。 */
async function requestedUrls(): Promise<string[]> {
  const seen: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    seen.push(String(url))
    return new Response(JSON.stringify({ version: '9.9.9', readme: '' }), { status: 200 })
  }))
  await checkForUpdate({ force: true })
  return seen
}

describe('包身份：查询用的是 scoped 名，不是裸名', () => {
  it('读到的包名是 @refeain/dsh-xdpool', () => {
    expect(PACKAGE_NAME).toBe('@refeain/dsh-xdpool')
    expect(PACKAGE_NAME).not.toBe(LEGACY_PACKAGE_NAME)
  })
  /**
   * 兜底值必须等于仓库 package.json 里的 name。
   *
   * 不能写成 `expect(FALLBACK_NAME).toBe(PACKAGE_NAME)`：两个都被改成裸名时它照样绿 ——
   * 那正是「断言两边同一个变量」的空转陷阱（AGENTS.md 记过这个坑）。这里从磁盘读真实的
   * 包名当基准，任何一侧退化成裸名都会被它抓住。
   */
  it('兜底值等于仓库 package.json 里的真实包名', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { name: string }
    expect(manifest.name).toBe('@refeain/dsh-xdpool')
    expect(FALLBACK_NAME).toBe(manifest.name)
  })

  it('KNOWN_PACKAGE_NAMES 同时认规范名与旧裸名，且规范名在前', () => {
    expect(KNOWN_PACKAGE_NAMES[0]).toBe(PACKAGE_NAME)
    expect(KNOWN_PACKAGE_NAMES).toContain(LEGACY_PACKAGE_NAME)
    expect(KNOWN_PACKAGE_NAMES).toHaveLength(2)
  })

  /**
   * 这条是整个 F1 的靶心。
   *
   * 裸名 `dsh-xdpool` 在 registry 上解析到 3.0.7（别人维护的另一个包），本包是 3.2.0。
   * 查询地址里必须出现编码后的 scoped 名，且不能出现 `npmjs.org/dsh-xdpool`。
   */
  it('checkForUpdate 请求的是编码后的 scoped 名', async () => {
    const urls = await requestedUrls()
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(url).toContain('%40refeain%2Fdsh-xdpool')
      // 未编码的 `/dsh-xdpool/latest` 是另一个包。
      expect(url).not.toMatch(/npmjs\.org\/dsh-xdpool(\/|$)/u)
    }
  })

  /**
   * tarball 地址必须来自版本元数据里的 `dist.tarball`，不能凭名字拼。
   *
   * scoped 包的 tarball 文件名不带 scope（`dsh-xdpool-3.3.0.tgz`），拼错就是 404 或装到别人
   * 的包。这条断言「读元数据」这一步真的发生了。
   */
  it('resolveTarballUrl 读 dist.tarball，而不是拼一个', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      seen.push(String(url))
      return new Response(JSON.stringify({
        dist: { tarball: 'https://registry.npmjs.org/@refeain/dsh-xdpool/-/dsh-xdpool-3.3.0.tgz' },
      }), { status: 200 })
    }))
    const url = await resolveTarballUrl('3.3.0')
    expect(url).toBe('https://registry.npmjs.org/@refeain/dsh-xdpool/-/dsh-xdpool-3.3.0.tgz')
    expect(seen[0]).toContain('%40refeain%2Fdsh-xdpool')
    expect(seen[0]).toContain('3.3.0')
  })

  /** 读不到元数据时退回约定地址 —— 那个地址仍然指向本包，不能退化成裸名。 */
  it('元数据读不到时退回的地址仍指向 scoped 包', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline') }))
    const url = await resolveTarballUrl('3.3.0')
    expect(url).toBe('https://registry.npmjs.org/@refeain/dsh-xdpool/-/dsh-xdpool-3.3.0.tgz')
    // 路径必须以 scoped 包名开头；裸名版本是 `npmjs.org/dsh-xdpool/-/...`，那是另一个包。
    expect(url).toContain('/@refeain/dsh-xdpool/-/')
    expect(url.startsWith('https://registry.npmjs.org/@refeain/')).toBe(true)
    // tarball 文件名本身不带 scope（npm 约定），这是对的，但目录不能是裸名。
    expect(url).not.toBe('https://registry.npmjs.org/dsh-xdpool/-/dsh-xdpool-3.3.0.tgz')
  })

  it('元数据形状不对时不编地址出来', () => {
    expect(parseVersionMetadata(null)).toBeUndefined()
    expect(parseVersionMetadata({})).toBeUndefined()
    expect(parseVersionMetadata({ dist: {} })).toBeUndefined()
    expect(parseVersionMetadata({ dist: { tarball: '' } })).toBeUndefined()
    expect(parseVersionMetadata({ dist: { tarball: 'https://x/y.tgz' } }))
      .toEqual({ tarball: 'https://x/y.tgz' })
  })

  /** scoped 名当文件名时必须压平，否则会造出不存在的子目录。 */
  it('packageFileStem 把斜杠压平且不含路径分隔符', () => {
    expect(packageFileStem('@refeain/dsh-xdpool')).toBe('@refeain+dsh-xdpool')
    expect(packageFileStem('@refeain/dsh-xdpool')).not.toContain('/')
    expect(packageFileStem('@refeain/dsh-xdpool')).not.toContain('\\')
    // 兜底地址的 tarball 文件名不带 scope。
    expect(fallbackTarballUrl('3.3.0')).toContain('/dsh-xdpool-3.3.0.tgz')
  })
})
