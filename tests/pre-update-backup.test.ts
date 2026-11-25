/**
 * 更新前自动备份 + 回退。
 *
 * 全部在 mkdtemp 临时目录里：DSH_HOME、profile、假的用户主目录都是临时的，网络用 stub 的
 * fetch 代替，不碰用户真实数据，也不访问 npm。
 *
 * 数据样例是 2.7.5 真实写出的文件格式（aggregate.json / accounts.json / ignored.json /
 * preferred.json / sticky-affinity.json / doubao-session.json / 导入的 .info 快照 /
 * channel-pack 的 state.json 和 token-ledger.json / 宿主 settings.yaml）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import {
  backupBeforeUpdate,
  listPreUpdateBackups,
  PRE_UPDATE_KEEP,
  pruneOldBackups,
  RESTORE_FILE_NAME,
  ROLLBACK_NOTE_NAME,
  rollbackPackageSpec,
  type RestoreManifest,
} from '../src/pre-update-backup.ts'
import { installVersion } from '../src/update-install.ts'
import { setSyncImplementationForTest } from '../src/update-install.ts'
import { POOL_VERSION } from '../src/version.ts'
import { PACKAGE_NAME } from '../src/update-package.ts'

/** 2.7.5 在 <DSH_HOME>/.xdpool 下写的文件。 */
const DATA_FILES: Record<string, string> = {
  'aggregate.json': JSON.stringify({
    version: 1,
    enabled: true,
    providers: { open_router: { enabled: true, apiKey: 'sk-or-v1-aaaa', addedAt: '2026-10-01T08:00:00.000Z' } },
    combos: [{ id: 'combo:写作', name: '写作', models: ['hy3'], strategy: 'fallback', stickyLimit: 1, enabled: true }],
    relay: { enabled: true, host: '0.0.0.0', port: 18790, key: 'relay-secret' },
  }, null, 2),
  'accounts.json': JSON.stringify({
    version: 1,
    accounts: [{
      id: '0123456789abcdef',
      label: '小明#12345678',
      credential: { accessToken: 'at-xxx', refreshToken: 'rt-yyy', uin: '12345678', domain: 'copilot.tencent.com' },
      savedAtMs: 1_790_000_000_000,
    }],
  }, null, 2),
  'ignored.json': JSON.stringify({ version: 1, accounts: [{ id: 'deadbeefdeadbeef', label: '旧号', ignoredAt: '2026-09-01T00:00:00.000Z' }] }, null, 2),
  'preferred.json': JSON.stringify({ version: 1, accountId: '0123456789abcdef' }, null, 2),
  'sticky-affinity.json': JSON.stringify({ version: 1, bindings: { 'conv-1': '0123456789abcdef' } }, null, 2),
  'doubao-session.json': JSON.stringify({ cookies: { sessionid: 'sid-123', uin: '900' }, userAgent: 'UA', savedAt: '2026-10-05T12:00:00.000Z' }),
  'startup.log': '2026-11-01T00:00:00.000Z apply entered host=desktop\n',
  '3f2a9c1d.info': '{"account":{"uin":"555"},"accessToken":"x","refreshToken":"y"}',
}

/** channel-pack 在 <DSH_HOME>/channel-pack 下写的文件。 */
const PACK_FILES: Record<string, string> = {
  'state.json': JSON.stringify({ accounts: [{ provider: 'trae', id: 'a1', credential: { token: 't' } }], disabledModels: {} }),
  'token-ledger.json': JSON.stringify({ days: { '2026-11-20': { 'direct|trae|a1|m': { input: 10, output: 20 } } } }),
  'dead-models.json': JSON.stringify({ trae: ['old-model'] }),
}

const SETTINGS_YAML = [
  'llm-xdpool:',
  '  distribution: sticky',
  '  creditReserves:',
  '    0123456789abcdef: 50',
  '  automation:',
  '    enabled: true',
  '    checkinHours: [9]',
  '',
].join('\n')

interface World {
  root: string
  home: string
  dsh: string
  data: string
  profile: string
  env: NodeJS.ProcessEnv
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
}

function makeWorld(options: { dshHomeSet?: boolean; spec?: string; packageName?: string } = {}): World {
  const root = mkdtempSync(join(tmpdir(), 'xdpool-preupdate-'))
  const home = join(root, 'user-home')
  const dshHomeSet = options.dshHomeSet ?? true
  const dsh = dshHomeSet ? join(root, 'dsh-home') : join(home, '.dsh')
  const data = join(dsh, '.xdpool')
  const profile = join(dsh, 'profiles', 'desktop')
  for (const [name, text] of Object.entries(DATA_FILES)) write(join(data, name), text)
  write(join(data, 'backups', '1790000000000-abcdef.a3.json'), '{"format":"dsh-xdpool/backup-encrypted"}')
  // 不该进备份的：临时浏览器配置、写到一半的 .tmp。
  write(join(data, 'login-profiles', 'marvis-1', 'Default', 'Cookies'), 'chrome-cookies')
  write(join(data, 'aggregate.json.tmp'), 'half')
  for (const [name, text] of Object.entries(PACK_FILES)) write(join(dsh, 'channel-pack', name), text)
  /**
   * profile 里那一行叫什么，是这次要覆盖的一个维度。
   *
   * 默认仍是旧裸名 `dsh-xdpool` —— 那是 3.2.0 之前由写死裸名的 fork 装出来的真实状态，
   * 更新链路最重要的兼容性就在这里。新装（规范名）的 profile 由 `packageName` 指定。
   */
  write(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-desktop',
    private: true,
    dependencies: {
      [options.packageName ?? 'dsh-xdpool']: options.spec ?? '2.7.5',
      'some-other-plugin': '1.0.0',
    },
  }, null, 2)}\n`)
  write(join(profile, 'settings.yaml'), SETTINGS_YAML)
  const env: NodeJS.ProcessEnv = dshHomeSet ? { DSH_HOME: dsh } : {}
  return { root, home, dsh, data, profile, env }
}

function manifestOf(dir: string): RestoreManifest {
  return JSON.parse(readFileSync(join(dir, RESTORE_FILE_NAME), 'utf8')) as RestoreManifest
}

const worlds: string[] = []
afterEach(() => {
  for (const root of worlds.splice(0)) rmSync(root, { recursive: true, force: true })
})
function world(options: { dshHomeSet?: boolean; spec?: string; packageName?: string } = {}): World {
  const made = makeWorld(options)
  worlds.push(made.root)
  return made
}

describe('backupBeforeUpdate', () => {
  it('把 2.7.5 的全部数据原样复制到 <数据目录>/pre-update/<旧版本>-<时间>/', () => {
    const w = world()
    const result = backupBeforeUpdate({
      profileDir: w.profile,
      previousVersion: '2.7.5',
      targetVersion: '2.7.6',
      previousSpecs: { dependencies: '2.7.5' },
      newSpec: 'file:C:/Temp/dsh-xdpool-2.7.6.tgz',
      env: w.env,
      home: w.home,
      now: new Date('2026-11-22T04:37:00.000Z'),
    })
    expect(result.ok, result.error).toBe(true)
    const dir = result.path ?? ''
    expect(dir).toBe(join(w.data, 'pre-update', '2.7.5-2026-11-22T04-37-00-000Z'))
    for (const [name, text] of Object.entries(DATA_FILES)) {
      expect(readFileSync(join(dir, 'xdpool', name), 'utf8'), name).toBe(text)
    }
    expect(existsSync(join(dir, 'xdpool', 'backups', '1790000000000-abcdef.a3.json'))).toBe(true)
    for (const [name, text] of Object.entries(PACK_FILES)) {
      expect(readFileSync(join(dir, 'channel-pack@dsh-home', name), 'utf8'), name).toBe(text)
    }
    expect(readFileSync(join(dir, 'profile', 'settings.yaml'), 'utf8')).toBe(SETTINGS_YAML)
    expect(readFileSync(join(dir, 'profile', 'package.json'), 'utf8'))
      .toBe(readFileSync(join(w.profile, 'package.json'), 'utf8'))
    // 跳过的东西确实没进来，备份也不会把自己复制进自己。
    expect(existsSync(join(dir, 'xdpool', 'login-profiles'))).toBe(false)
    expect(existsSync(join(dir, 'xdpool', 'pre-update'))).toBe(false)
    expect(existsSync(join(dir, 'xdpool', 'aggregate.json.tmp'))).toBe(false)
  })

  it('restore.json 记下原 spec、旧版本号和时间，回退说明.txt 是中文', () => {
    const w = world()
    const result = backupBeforeUpdate({
      profileDir: w.profile,
      previousVersion: '2.7.5',
      targetVersion: '2.7.6',
      previousSpecs: { dependencies: '2.7.5' },
      newSpec: '3.3.0',
      env: w.env,
      home: w.home,
      now: new Date('2026-11-22T04:37:00.000Z'),
    })
    const manifest = manifestOf(result.path ?? '')
    expect(manifest).toMatchObject({
      // 新备份写的是现在的发布身份，不再是裸名 —— 裸名指向 npm 上的另一个包。
      package: PACKAGE_NAME,
      previousVersion: '2.7.5',
      targetVersion: '2.7.6',
      previousSpec: '2.7.5',
      previousSpecs: { dependencies: '2.7.5' },
      rollbackSpec: '2.7.5',
      newSpec: '3.3.0',
      createdAt: '2026-11-22T04:37:00.000Z',
      packageJsonPath: join(w.profile, 'package.json'),
    })
    expect(manifest.entries.map(entry => entry.label)).toEqual(['xdpool', 'channel-pack@dsh-home', 'profile'])
    expect(manifest.files).toBeGreaterThan(10)
    const note = readFileSync(join(result.path ?? '', ROLLBACK_NOTE_NAME), 'utf8')
    expect(note).toContain('回退')
    expect(note).toContain('2.7.5')
  })

  /**
   * 锁文件必须一起备份。
   *
   * 更新会写 package.json 并让 pnpm 重写 pnpm-lock.yaml。如果备份里只有清单没有锁文件，
   * 「回退」就只能把清单改回去，而锁文件还停在新版本 —— 下一 次启动按它装回新版，
   * 用户看到的是「回退了却还是新版」。
   */
  it('备份里包含 pnpm-lock.yaml（恢复锁文件的前提）', () => {
    const w = world()
    write(join(w.profile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    const result = backupBeforeUpdate({
      profileDir: w.profile,
      previousVersion: '3.2.0',
      targetVersion: '3.3.0',
      previousSpecs: { dependencies: '3.2.0' },
      newSpec: '3.3.0',
      env: w.env,
      home: w.home,
    })
    expect(result.ok, result.error).toBe(true)
    const saved = join(result.path ?? '', 'profile', 'pnpm-lock.yaml')
    expect(existsSync(saved)).toBe(true)
    expect(readFileSync(saved, 'utf8')).toContain('lockfileVersion')
  })

  /** 原来没有锁文件时，备份里也不该凭空造一个。 */
  it('原来没有锁文件就不复制一个空文件进去', () => {
    const w = world()
    const result = backupBeforeUpdate({
      profileDir: w.profile,
      previousVersion: '3.2.0',
      targetVersion: '3.3.0',
      previousSpecs: { dependencies: '3.2.0' },
      newSpec: '3.3.0',
      env: w.env,
      home: w.home,
    })
    expect(existsSync(join(result.path ?? '', 'profile', 'pnpm-lock.yaml'))).toBe(false)
  })

  it('原数据一个字节都不改', () => {
    const w = world()
    backupBeforeUpdate({
      profileDir: w.profile, previousVersion: '2.7.5', targetVersion: '2.7.6',
      previousSpecs: { dependencies: '2.7.5' }, env: w.env, home: w.home,
    })
    for (const [name, text] of Object.entries(DATA_FILES)) {
      expect(readFileSync(join(w.data, name), 'utf8')).toBe(text)
    }
  })

  it('没设 DSH_HOME 时 aggregate.json 在 ~/.xdpool（store.ts 一直如此），那一份也备份', () => {
    const w = world({ dshHomeSet: false })
    write(join(w.home, '.xdpool', 'aggregate.json'), '{"version":1,"providers":{"open_router":{"apiKey":"sk-home"}}}')
    const result = backupBeforeUpdate({
      profileDir: w.profile, previousVersion: '2.7.5', targetVersion: '2.7.6',
      previousSpecs: { dependencies: '2.7.5' }, env: w.env, home: w.home,
    })
    expect(result.ok, result.error).toBe(true)
    expect(result.path?.startsWith(join(w.home, '.dsh', '.xdpool', 'pre-update'))).toBe(true)
    expect(readFileSync(join(result.path ?? '', 'home-xdpool', 'aggregate.json'), 'utf8')).toContain('sk-home')
    expect(readFileSync(join(result.path ?? '', 'xdpool', 'accounts.json'), 'utf8')).toBe(DATA_FILES['accounts.json'])
  })

  it('原 spec 是本地 .tgz 时把它也复制进来，回退用备份里那份', () => {
    const w = world()
    const tarball = join(w.root, 'Temp', 'dsh-xdpool-2.7.5.tgz')
    write(tarball, 'old-tarball-bytes')
    const spec = `file:${tarball.replaceAll('\\', '/')}`
    const result = backupBeforeUpdate({
      profileDir: w.profile, previousVersion: '2.7.5', targetVersion: '2.7.6',
      previousSpecs: { dependencies: spec }, env: w.env, home: w.home,
    })
    const manifest = manifestOf(result.path ?? '')
    expect(manifest.previousSpec).toBe(spec)
    expect(manifest.previousTarball).toBe(join(result.path ?? '', 'previous-package', 'dsh-xdpool-2.7.5.tgz'))
    expect(readFileSync(manifest.previousTarball ?? '', 'utf8')).toBe('old-tarball-bytes')
    expect(manifest.rollbackSpec).toBe(`file:${(manifest.previousTarball ?? '').replaceAll('\\', '/')}`)
  })

  it('复制失败就返回中文原因，并删掉写了一半的备份目录', () => {
    const w = world()
    // 备份根目录被一个同名文件占着：mkdir 一定失败。
    write(join(w.data, 'pre-update'), 'not a directory')
    const result = backupBeforeUpdate({
      profileDir: w.profile, previousVersion: '2.7.5', targetVersion: '2.7.6',
      previousSpecs: { dependencies: '2.7.5' }, env: w.env, home: w.home,
    })
    expect(result.ok).toBe(false)
    expect(result.path).toBeUndefined()
    expect(result.error).toMatch(/更新前备份失败/u)
    expect(result.error).toMatch(/已取消更新/u)
    expect(readFileSync(join(w.data, 'pre-update'), 'utf8')).toBe('not a directory')
  })
})

describe('只保留最近 5 份', () => {
  function fakeBackup(root: string, name: string, createdAt: string): string {
    const dir = join(root, name)
    write(join(dir, RESTORE_FILE_NAME), JSON.stringify({ package: 'dsh-xdpool', format: 1, createdAt, previousVersion: name, targetVersion: 'x' }))
    return dir
  }

  it('删最旧的，只删自己建的目录', () => {
    const w = world()
    const root = join(w.data, 'pre-update')
    const made: string[] = []
    for (let day = 1; day <= 7; day += 1) {
      made.push(fakeBackup(root, `2.7.${String(day)}-x`, `2026-11-0${String(day)}T00:00:00.000Z`))
    }
    write(join(root, 'user-notes', 'keep.txt'), '用户自己放的')
    write(join(root, 'stray-file.txt'), 'x')
    const removed = pruneOldBackups(root)
    expect(removed.sort()).toEqual([made[0], made[1]].sort())
    expect(listPreUpdateBackups(root)).toHaveLength(PRE_UPDATE_KEEP)
    expect(existsSync(join(root, 'user-notes', 'keep.txt'))).toBe(true)
    expect(existsSync(join(root, 'stray-file.txt'))).toBe(true)
  })

  it('刚建的那一份无论排第几都不删', () => {
    const w = world()
    const root = join(w.data, 'pre-update')
    const made: string[] = []
    for (let day = 1; day <= 7; day += 1) {
      made.push(fakeBackup(root, `2.7.${String(day)}-x`, `2026-11-0${String(day)}T00:00:00.000Z`))
    }
    const oldest = made[0] ?? ''
    pruneOldBackups(root, PRE_UPDATE_KEEP, oldest)
    const left = listPreUpdateBackups(root).map(backup => backup.path)
    expect(left).toHaveLength(PRE_UPDATE_KEEP)
    expect(left).toContain(oldest)
  })
})

describe('rollbackPackageSpec', () => {
  it('把旧裸名那一行改回更新前的 spec，别的依赖不动', () => {
    const w = world()
    const result = backupBeforeUpdate({
      profileDir: w.profile, previousVersion: '2.7.5', targetVersion: '2.7.6',
      previousSpecs: { dependencies: '2.7.5' }, env: w.env, home: w.home,
    })
    const pkgPath = join(w.profile, 'package.json')
    const updated = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies: Record<string, string> }
    updated.dependencies['dsh-xdpool'] = 'file:C:/Temp/dsh-xdpool-2.7.6.tgz'
    writeFileSync(pkgPath, JSON.stringify(updated), 'utf8')
    const rollback = rollbackPackageSpec(result.path ?? '')
    expect(rollback).toEqual({ ok: true, spec: '2.7.5', restartRequired: true })
    const after = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies: Record<string, string> }
    /**
     * 键回到**裸名**：备份里的原 profile 清单记着当时就是这一行，回退就是回到那个样子。
     */
    expect(after.dependencies).toEqual({ 'dsh-xdpool': '2.7.5', 'some-other-plugin': '1.0.0' })
  })

  /**
   * 回退一个从裸名迁到规范名的更新：规范名那行要删掉，裸名那行写回原 spec。
   *
   * 只写回 spec、不删迁移行的话，pnpm 会当成两个包各装一份 —— 一句话就制造出「更新后
   * 版本没变，反而多了一个包」。这条断言守的就是这个。
   */
  it('回退迁移过的 profile：删掉规范名那一行，把裸名写回原 spec', () => {
    const w = world()
    const result = backupBeforeUpdate({
      profileDir: w.profile,
      previousVersion: '3.2.0',
      targetVersion: '3.3.0',
      previousSpecs: { dependencies: '3.2.0' },
      previousKeys: { dependencies: 'dsh-xdpool' },
      newSpec: '3.3.0',
      env: w.env,
      home: w.home,
    })
    // 模拟更新后的状态：迁移到规范名。
    const pkgPath = join(w.profile, 'package.json')
    const updated = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies: Record<string, string> }
    delete updated.dependencies['dsh-xdpool']
    updated.dependencies[PACKAGE_NAME] = '3.3.0'
    writeFileSync(pkgPath, JSON.stringify(updated), 'utf8')

    const rollback = rollbackPackageSpec(result.path ?? '')
    expect(rollback.ok, rollback.error).toBe(true)
    const after = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies: Record<string, string> }
    expect(after.dependencies['dsh-xdpool']).toBe('3.2.0')
    expect(after.dependencies[PACKAGE_NAME]).toBeUndefined()
    expect(after.dependencies['some-other-plugin']).toBe('1.0.0')
  })

  /** 新装（规范名）的 profile 回退：键还是规范名，不会冒出一个裸名。 */
  it('规范名的 profile 回退后键仍是规范名', () => {
    const w = world({ packageName: PACKAGE_NAME })
    const result = backupBeforeUpdate({
      profileDir: w.profile,
      previousVersion: '3.2.0',
      targetVersion: '3.3.0',
      previousSpecs: { dependencies: '3.2.0' },
      previousKeys: { dependencies: PACKAGE_NAME },
      newSpec: '3.3.0',
      env: w.env,
      home: w.home,
    })
    const pkgPath = join(w.profile, 'package.json')
    const updated = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies: Record<string, string> }
    updated.dependencies[PACKAGE_NAME] = '3.3.0'
    writeFileSync(pkgPath, JSON.stringify(updated), 'utf8')
    expect(rollbackPackageSpec(result.path ?? '').ok).toBe(true)
    const after = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies: Record<string, string> }
    expect(after.dependencies[PACKAGE_NAME]).toBe('3.2.0')
    expect(after.dependencies['dsh-xdpool']).toBeUndefined()
  })

  /**
   * 旧 format=1 备份（没有 previousKeys，也不一定存了 profile 清单）靠 restore.json 里的
   * `package` 判断键 —— 那是写死裸名的 fork 留下的，`package: 'dsh-xdpool'`。
   */
  it('旧裸名备份（无 previousKeys）按 package 字段写回裸名', () => {
    const w = world()
    const backupDir = join(w.data, 'pre-update', '3.1.0-legacy')
    write(join(backupDir, RESTORE_FILE_NAME), JSON.stringify({
      package: 'dsh-xdpool',
      format: 1,
      createdAt: '2026-11-20T00:00:00.000Z',
      previousVersion: '3.1.0',
      targetVersion: '3.2.0',
      profileDir: w.profile,
      packageJsonPath: join(w.profile, 'package.json'),
      previousSpec: '3.1.0',
      previousSpecs: { dependencies: '3.1.0' },
    }))
    // 模拟那次旧 fork 的更新把键改成了它自己的名字。
    const pkgPath = join(w.profile, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies: Record<string, string> }
    pkg.dependencies['dsh-xdpool'] = '3.2.0'
    writeFileSync(pkgPath, JSON.stringify(pkg), 'utf8')

    const rollback = rollbackPackageSpec(backupDir)
    expect(rollback.ok, rollback.error).toBe(true)
    const after = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies: Record<string, string> }
    expect(after.dependencies['dsh-xdpool']).toBe('3.1.0')
  })

  /**
   * 备份里的原 profile 清单同时出现两个名字 = 身份不明确。不猜，说清楚原因。
   */
  it('身份不明确时拒绝回退并说明需要人工选择', () => {
    const w = world()
    const backupDir = join(w.data, 'pre-update', 'ambiguous')
    write(join(backupDir, RESTORE_FILE_NAME), JSON.stringify({
      package: 'dsh-xdpool',
      format: 1,
      createdAt: '2026-11-20T00:00:00.000Z',
      previousVersion: '3.1.0',
      targetVersion: '3.2.0',
      profileDir: w.profile,
      packageJsonPath: join(w.profile, 'package.json'),
      previousSpec: '3.1.0',
      previousSpecs: { dependencies: '3.1.0' },
    }))
    write(join(backupDir, 'profile', 'package.json'), JSON.stringify({
      dependencies: { 'dsh-xdpool': '3.1.0', [PACKAGE_NAME]: '3.1.0' },
    }))
    const before = readFileSync(join(w.profile, 'package.json'), 'utf8')
    const rollback = rollbackPackageSpec(backupDir)
    expect(rollback.ok).toBe(false)
    expect(rollback.error).toMatch(/同时存在/u)
    expect(rollback.error).toMatch(/手动|人工/u)
    // 拒绝时不能动 package.json。
    expect(readFileSync(join(w.profile, 'package.json'), 'utf8')).toBe(before)
  })

  /** 旧备份里没有积木级 profile 清单时，仍能靠 previousSpecs + package 回退。 */
  it('旧备份没存 profile 清单也能回退（按 package 字段）', () => {
    const w = world()
    const backupDir = join(w.data, 'pre-update', 'no-profile-manifest')
    write(join(backupDir, RESTORE_FILE_NAME), JSON.stringify({
      package: 'dsh-xdpool',
      format: 1,
      previousVersion: '3.1.0',
      targetVersion: '3.2.0',
      packageJsonPath: join(w.profile, 'package.json'),
      previousSpecs: { dependencies: '3.1.0' },
    }))
    const pkgPath = join(w.profile, 'package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies: Record<string, string> }
    pkg.dependencies['dsh-xdpool'] = '3.2.0'
    writeFileSync(pkgPath, JSON.stringify(pkg), 'utf8')
    expect(rollbackPackageSpec(backupDir).ok).toBe(true)
    const after = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dependencies: Record<string, string> }
    expect(after.dependencies['dsh-xdpool']).toBe('3.1.0')
  })

  it('目录里没有 restore.json 时给中文错误', () => {
    const w = world()
    const rollback = rollbackPackageSpec(join(w.root, 'nowhere'))
    expect(rollback.ok).toBe(false)
    expect(rollback.error).toMatch(/无法回退/u)
  })
})

describe('installVersion：下载 → 校验 → 备份 → 写入', () => {
  const saved: Record<string, string | undefined> = {}
  const KEYS = ['DSH_HOME', 'DSH_PROFILE_DIR', 'DSH_CHANNEL_PACK_STATE_DIR'] as const
  let version = ''

  /** 本轮测试期间出现在 tmpdir 里的 `xdpool-update-*` 临时目录。 */
  function stagingDirs(): string[] {
    try {
      return readdirSync(tmpdir())
        .filter(name => name.startsWith('xdpool-update-'))
        .map(name => join(tmpdir(), name))
    } catch {
      return []
    }
  }
  /** 每个用例开始时已经存在的临时目录；只清理本用例新建的，别的进程的不碰。 */
  let stagingBefore = new Set<string>()

  const defaultSync = async (): Promise<{ ok: boolean; detail: string }> => ({ ok: true, detail: 'test stub' })

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key]
    version = `0.0.0-compat-test-${String(Date.now())}-${String(Math.floor(Math.random() * 1e6))}`
    stagingBefore = new Set(stagingDirs())
    setSyncImplementationForTest(defaultSync)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    setSyncImplementationForTest(defaultSync)
    for (const key of KEYS) {
      const value = saved[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(join(tmpdir(), `dsh-xdpool-${version}.tgz`), { force: true })
    rmSync(join(tmpdir(), `dsh-xdpool-${version}.tgz.part`), { force: true })
    // 下载现在落在 mkdtemp 出来的独占目录里，按版本号清不掉；只清本用例新建的。
    for (const dir of stagingDirs()) {
      if (stagingBefore.has(dir)) continue
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function point(w: World): void {
    process.env['DSH_HOME'] = w.dsh
    process.env['DSH_PROFILE_DIR'] = w.profile
    delete process.env['DSH_CHANNEL_PACK_STATE_DIR']
  }

  function serve(body: Uint8Array | string, status = 200): void {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })))
  }

  it('成功时四步都打勾，返回备份目录和旧版本号，package.json 指向新包', async () => {
    const w = world()
    point(w)
    serve(gzipSync(Buffer.from('fake tarball')))
    const result = await installVersion(version)
    expect(result.ok, result.error).toBe(true)
    expect(result.restartRequired).toBe(true)
    expect(result.previousVersion).toBe(POOL_VERSION)
    expect(result.steps?.map(step => [step.id, step.ok])).toEqual([
      ['download', true], ['verify', true], ['backup', true], ['write', true], ['sync', true],
    ])
    const backupPath = result.backupPath ?? ''
    expect(backupPath.startsWith(join(w.data, 'pre-update'))).toBe(true)
    const manifest = manifestOf(backupPath)
    expect(manifest.previousSpec).toBe('2.7.5')
    expect(manifest.previousVersion).toBe(POOL_VERSION)
    expect(manifest.targetVersion).toBe(version)
    expect(readFileSync(join(backupPath, 'xdpool', 'aggregate.json'), 'utf8')).toBe(DATA_FILES['aggregate.json'])
    const pkg = JSON.parse(readFileSync(join(w.profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    /**
     * 写的是**版本号**，不是 `file:<下载下来的 tgz>`。
     *
     * 那个写法有三处被用户报上来的毛病：插件市场按 `link:`/`file:` 判定「本地开发」从而
     * 不再提供更新、路径指向系统临时目录（被清理后下次启动直接加载失败）、以及市场显示的
     * 「3.0.1.tgz」与实际 bundle 的版本号对不上。
     *
     * 键是**规范包名**：这个 profile 原先是裸名 `dsh-xdpool`，更新会把它迁到 `@refeain/…`，
     * 否则 pnpm 会同时装两个包 —— 裸名那个在 npm 上指向别人维护的 3.0.x。
     */
    expect(pkg.dependencies[PACKAGE_NAME]).toBe(version)
    expect(pkg.dependencies['dsh-xdpool']).toBeUndefined()
    expect(pkg.dependencies['some-other-plugin']).toBe('1.0.0')
    expect(existsSync(join(w.profile, 'package.json.tmp'))).toBe(false)
  })

  it('已经是规范名的 profile：键不变，也不多出一行裸名', async () => {
    const w = world({ packageName: PACKAGE_NAME })
    point(w)
    serve(gzipSync(Buffer.from('fake tarball')))
    const result = await installVersion(version)
    expect(result.ok, result.error).toBe(true)
    const pkg = JSON.parse(readFileSync(join(w.profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies[PACKAGE_NAME]).toBe(version)
    expect(pkg.dependencies['dsh-xdpool']).toBeUndefined()
  })

  /**
   * 同一块里两个名字都在 = 历史误装。两个都改会让回退说不清恢复哪一行，所以拒绝并说明。
   */
  it('同一依赖块里同时存在裸名和规范名时拒绝更新并说明原因', async () => {
    const w = world()
    point(w)
    const manifestPath = join(w.profile, 'package.json')
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
    pkg.dependencies[PACKAGE_NAME] = '3.1.0'
    writeFileSync(manifestPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    const before = readFileSync(manifestPath, 'utf8')
    serve(gzipSync(Buffer.from('fake tarball')))
    const result = await installVersion(version)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/同时存在/u)
    expect(result.error).toMatch(/手动/u)
    expect(readFileSync(manifestPath, 'utf8')).toBe(before)
    expect(existsSync(join(w.data, 'pre-update'))).toBe(false)
  })

  it('备份失败就中止：package.json 不动，错误是中文，最后一步是 backup 失败', async () => {
    const w = world()
    point(w)
    write(join(w.data, 'pre-update'), 'not a directory')
    const before = readFileSync(join(w.profile, 'package.json'), 'utf8')
    serve(gzipSync(Buffer.from('fake tarball')))
    const result = await installVersion(version)
    expect(result.ok).toBe(false)
    expect(result.restartRequired).toBe(false)
    expect(result.backupPath).toBeUndefined()
    expect(result.error).toMatch(/已取消更新/u)
    expect(result.steps?.at(-1)).toMatchObject({ id: 'backup', ok: false })
    expect(result.steps?.some(step => step.id === 'write')).toBe(false)
    expect(readFileSync(join(w.profile, 'package.json'), 'utf8')).toBe(before)
  })

  it('下载到的不是压缩包：停在校验，不备份也不写', async () => {
    const w = world()
    point(w)
    const before = readFileSync(join(w.profile, 'package.json'), 'utf8')
    serve('<html>proxy login</html>')
    const result = await installVersion(version)
    expect(result.ok).toBe(false)
    expect(result.error).toBe('下载到的不是压缩包（可能被代理拦截）')
    expect(result.steps?.map(step => [step.id, step.ok])).toEqual([['download', true], ['verify', false]])
    expect(existsSync(join(w.data, 'pre-update'))).toBe(false)
    expect(readFileSync(join(w.profile, 'package.json'), 'utf8')).toBe(before)
  })

  it('HTTP 失败：错误是中文并带状态码', async () => {
    const w = world()
    point(w)
    serve('not found', 404)
    const result = await installVersion(version)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/下载失败.*404/u)
    expect(result.steps).toEqual([{ id: 'download', ok: false, detail: 'HTTP 404' }])
  })

  it('网络错误也给中文', async () => {
    const w = world()
    point(w)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const result = await installVersion(version)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/[\u4e00-\u9fff]/u)
    expect(result.steps?.[0]).toMatchObject({ id: 'download', ok: false })
  })

  it('profile 里没有本插件：不建备份，停在写入', async () => {
    const w = world()
    point(w)
    writeFileSync(join(w.profile, 'package.json'), JSON.stringify({ dependencies: { other: '1' } }), 'utf8')
    serve(gzipSync(Buffer.from('fake tarball')))
    const result = await installVersion(version)
    expect(result.ok).toBe(false)
    expect(result.error).toContain(`没有 ${PACKAGE_NAME}`)
    expect(result.steps?.at(-1)).toMatchObject({ id: 'write', ok: false })
    expect(existsSync(join(w.data, 'pre-update'))).toBe(false)
  })

  it('连续更新 7 次只留 5 份备份，最新那份一定在', async () => {
    const w = world()
    point(w)
    let last = ''
    for (let round = 0; round < 7; round += 1) {
      serve(gzipSync(Buffer.from(`fake tarball ${String(round)}`)))
      const result = await installVersion(version)
      expect(result.ok, result.error).toBe(true)
      last = result.backupPath ?? ''
    }
    const left = readdirSync(join(w.data, 'pre-update'))
    expect(left).toHaveLength(PRE_UPDATE_KEEP)
    expect(left.map(name => join(w.data, 'pre-update', name))).toContain(last)
  })

  /**
   * 同步返回失败：清单与锁文件都要回到更新前，且错误里只承诺能确认的那部分。
   *
   * 3.2.0 的提示是「已回滚，插件和数据都没有改动」—— 那句话超出了代码能知道的范围：
   * pnpm 在失败前可能已经换过 node_modules 里的目录。现在只承认清单与锁文件，
   * 并明确说 node_modules 未确认，再给出重试 / 重启两条出路。
   */
  it('同步返回失败：清单与锁文件都回滚，提示只承诺文件级恢复并说明 node_modules 未确认', async () => {
    const w = world()
    point(w)
    write(join(w.profile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nold: true\n")
    const beforePkg = readFileSync(join(w.profile, 'package.json'), 'utf8')
    const beforeLock = readFileSync(join(w.profile, 'pnpm-lock.yaml'), 'utf8')
    serve(gzipSync(Buffer.from('fake tarball')))
    setSyncImplementationForTest(async () => {
      // 模拟 pnpm 已改了锁文件再失败。
      writeFileSync(join(w.profile, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\nnew: true\n", 'utf8')
      return { ok: false, detail: 'pnpm 退出码 1' }
    })
    const result = await installVersion(version)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('pnpm 退出码 1')
    // 文件级恢复必须点明是哪两个文件。
    expect(result.error).toContain('package.json 与 pnpm-lock.yaml 已恢复')
    // 依赖目录的状态不在可确认范围，必须说出来。
    expect(result.error).toContain('node_modules')
    expect(result.error).toMatch(/无法.*确认|未确认/u)
    // 不能承诺「都没有改动」。
    expect(result.error).not.toContain('都没有改动')
    // 要有可执行的出路。
    expect(result.error).toMatch(/重试|重启/u)
    expect(readFileSync(join(w.profile, 'package.json'), 'utf8')).toBe(beforePkg)
    expect(readFileSync(join(w.profile, 'pnpm-lock.yaml'), 'utf8')).toBe(beforeLock)
    expect(result.steps?.at(-1)).toMatchObject({ id: 'write', ok: false })
    // 备份照旧留着，用户可以手动回退。
    expect(result.backupPath).toBeDefined()
  })

  /**
   * 同步**部分改过 node_modules 之后**才失败：这正是「都没有改动」不成立的场景。
   *
   * 钩子里先往 node_modules 写一个文件、再返回失败。文件级恢复能回滚清单与锁文件，
   * 却回不去那个目录 —— 提示必须承认这一点，而不是让用户以为一切照旧。
   */
  it('同步部分改过 node_modules 后失败时，提示承认依赖目录可能已被改动', async () => {
    const w = world()
    point(w)
    const beforePkg = readFileSync(join(w.profile, 'package.json'), 'utf8')
    const modules = join(w.profile, 'node_modules', PACKAGE_NAME)
    serve(gzipSync(Buffer.from('fake tarball')))
    setSyncImplementationForTest(async () => {
      mkdirSync(modules, { recursive: true })
      writeFileSync(join(modules, 'package.json'), '{"name":"half-installed"}', 'utf8')
      return { ok: false, detail: 'pnpm 在替换依赖时被占用' }
    })
    const result = await installVersion(version)
    expect(result.ok).toBe(false)
    // 半成品仍然在盘上 —— 恢复代码不会去动它，所以提示必须承认。
    expect(existsSync(join(modules, 'package.json'))).toBe(true)
    expect(result.error).not.toContain('都没有改动')
    expect(result.error).toContain('node_modules')
    expect(result.error).toMatch(/部分改动|可能已/u)
    expect(readFileSync(join(w.profile, 'package.json'), 'utf8')).toBe(beforePkg)
  })

  /**
   * 同步钩子抛异常也要走同一条恢复路径。
   *
   * 以前这个分支落到外层 catch，只报了「写入失败」，却没恢复已经改过的 package.json。
   */
  it('同步钩子抛出异常：同样回滚，错误里说明是异常', async () => {
    const w = world()
    point(w)
    const beforePkg = readFileSync(join(w.profile, 'package.json'), 'utf8')
    serve(gzipSync(Buffer.from('fake tarball')))
    setSyncImplementationForTest(async () => {
      throw new Error('spawn pnpm ENOENT')
    })
    const result = await installVersion(version)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('spawn pnpm ENOENT')
    expect(result.error).toContain('package.json 与 pnpm-lock.yaml 已恢复')
    expect(result.error).not.toContain('都没有改动')
    expect(readFileSync(join(w.profile, 'package.json'), 'utf8')).toBe(beforePkg)
  })

  /**
   * 恢复本身再次失败：不能宣称「没有改动」。必须明确说回滚未完成，并给出备份路径。
   *
   * 构造方式：在同步钩子里把 package.json 换成一个**目录**（内容先读出来），于是随后
   * 「把清单写回去」的那次 rename 必然失败。这正是磁盘异常 / 权限被改 / 进程被杀之后
   * 可能出现的状态 —— 恢复代码必须能识别出自己没成功。
   */
  it('恢复也失败时不谎称没有改动，而是说明回滚未完成并给出备份路径', async () => {
    const w = world()
    point(w)
    const pkgPath = join(w.profile, 'package.json')
    serve(gzipSync(Buffer.from('fake tarball')))
    setSyncImplementationForTest(async () => {
      rmSync(pkgPath, { force: true })
      mkdirSync(pkgPath, { recursive: true })
      return { ok: false, detail: '同步失败' }
    })
    const result = await installVersion(version)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('回滚未完成')
    // 不能出现「插件和数据都没有改动」这种不实承诺。
    expect(result.error).not.toContain('都没有改动')
    expect(result.error).toContain(result.backupPath ?? '<无备份>')
  })

  /** 更新前 profile 里没有锁文件，但同步过程造出了一个 —— 回滚要把这个新文件删掉。 */
  it('更新前没有锁文件时，回滚会把同步过程新建的锁文件删掉', async () => {
    const w = world()
    point(w)
    const lockPath = join(w.profile, 'pnpm-lock.yaml')
    expect(existsSync(lockPath)).toBe(false)
    serve(gzipSync(Buffer.from('fake tarball')))
    setSyncImplementationForTest(async () => {
      writeFileSync(lockPath, "lockfileVersion: '9.0'\nhalf: true\n", 'utf8')
      return { ok: false, detail: '同步一半失败' }
    })
    const result = await installVersion(version)
    expect(result.ok).toBe(false)
    expect(existsSync(lockPath)).toBe(false)
  })

  /** devDependencies / optionalDependencies 上的原有键也要一起更新（不是只认 dependencies）。 */
  it('三个依赖块里的本插件键都会被更新', async () => {
    const w = world()
    point(w)
    const manifestPath = join(w.profile, 'package.json')
    writeFileSync(manifestPath, `${JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: { 'dsh-xdpool': '2.7.5' },
      devDependencies: { 'dsh-xdpool': '2.7.4' },
      optionalDependencies: { 'dsh-xdpool': '2.7.3' },
    }, null, 2)}\n`, 'utf8')
    serve(gzipSync(Buffer.from('fake tarball')))
    const result = await installVersion(version)
    expect(result.ok, result.error).toBe(true)
    const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
      optionalDependencies: Record<string, string>
    }
    for (const block of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      expect(pkg[block][PACKAGE_NAME]).toBe(version)
      expect(pkg[block]['dsh-xdpool']).toBeUndefined()
    }
  })

  /**
   * 连续更新两次：第二次读到的已经是规范名，并且不会因为「找不到裸名」而失败。
   */
  it('连续更新两次：第二次从规范名出发也能成功，键始终只有一行', async () => {
    const w = world()
    point(w)
    serve(gzipSync(Buffer.from('fake tarball 1')))
    const first = await installVersion(version)
    expect(first.ok, first.error).toBe(true)
    const second = await installVersion(version)
    expect(second.ok, second.error).toBe(true)
    const pkg = JSON.parse(readFileSync(join(w.profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies[PACKAGE_NAME]).toBe(version)
    expect(pkg.dependencies['dsh-xdpool']).toBeUndefined()
    // 第二份备份记的键是规范名，能正确回退。
    const rollback = rollbackPackageSpec(second.backupPath ?? '')
    expect(rollback.ok, rollback.error).toBe(true)
    const after = JSON.parse(readFileSync(join(w.profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(after.dependencies[PACKAGE_NAME]).toBe(version)
  })

  /**
   * 守卫：临时目录必须是独占的。
   *
   * 两个更新同时开始时，共用一个 `.part` 会让谁也没完整写过的 tar 包被当成新版本装上。
   * 这条断言要求每次下载都落在不同的目录里 —— 把 mkdtemp 改回固定路径就会失败。
   */
  it('每次下载落在各自独占的临时目录里', async () => {
    const w = world()
    point(w)
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      seen.push(String(url))
      return new Response(gzipSync(Buffer.from('fake tarball')))
    }))
    await installVersion(version)
    await installVersion(version)
    const dirs = stagingDirs().filter(dir => !stagingBefore.has(dir))
    expect(dirs.length).toBeGreaterThanOrEqual(2)
    expect(new Set(dirs).size).toBe(dirs.length)
  })

  /**
   * 锁文件**存在但读不出来**时不许更新。
   *
   * 3.2.0 的 snapshotFile 把所有读取异常都当成「文件不存在」，于是恢复阶段会按「更新前没有
   * 锁文件」处理 —— 把一个真实存在的 lockfile 删掉，用户的下一启动就换了整套解析结果。
   * 构造方式：把 pnpm-lock.yaml 做成**目录**，readFileSync 会抛 EISDIR（不是 ENOENT），
   * 正好落在「存在但读不出」这一格。
   */
  it('锁文件存在但读不出来时取消更新，既不动清单也不删文件', async () => {
    const w = world()
    point(w)
    const lockPath = join(w.profile, 'pnpm-lock.yaml')
    mkdirSync(lockPath, { recursive: true })
    writeFileSync(join(lockPath, 'inner.txt'), 'still here', 'utf8')
    const beforePkg = readFileSync(join(w.profile, 'package.json'), 'utf8')
    serve(gzipSync(Buffer.from('fake tarball')))
    const result = await installVersion(version)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('pnpm-lock.yaml')
    expect(result.error).toContain('读不到')
    // 文件（这里是目录）必须原样留着 —— 被当成「不存在」就会 rmSync 掉。
    expect(existsSync(join(lockPath, 'inner.txt'))).toBe(true)
    expect(readFileSync(join(w.profile, 'package.json'), 'utf8')).toBe(beforePkg)
    // 快照在建备份之前取，失败时连一份新备份都不该留下。
    expect(existsSync(join(w.data, 'pre-update'))).toBe(false)
    expect(result.backupPath).toBeUndefined()
  })

  /** 锁文件本来就不存在时不算错误 —— 那是正常状态，更新应当照常进行。 */
  it('锁文件确实不存在时照常更新（不存在不是错误）', async () => {
    const w = world()
    point(w)
    expect(existsSync(join(w.profile, 'pnpm-lock.yaml'))).toBe(false)
    serve(gzipSync(Buffer.from('fake tarball')))
    const result = await installVersion(version)
    expect(result.ok, result.error).toBe(true)
  })

  /**
   * 同一 profile 的并发更新合并成一次。
   *
   * `POST /plugins/dsh-xdpool/update` 是 HTTP 入口，两个标签页（或脚本）可以同时打进来。
   * 不做互斥的话双方各读一份旧清单、各建一份备份，后成的那次还会把清单与锁文件交错写。
   */
  it('并发调用合并成一次：只建一份备份，两次拿到同一个结果', async () => {
    const w = world()
    point(w)
    let syncCalls = 0
    serve(gzipSync(Buffer.from('fake tarball')))
    setSyncImplementationForTest(async () => {
      syncCalls += 1
      // 给第二个请求足够的时间挤进同一个窗口。
      await new Promise<void>(done => { setTimeout(done, 50) })
      return { ok: true, detail: 'test stub' }
    })
    const [first, second] = await Promise.all([installVersion(version), installVersion(version)])
    expect(first.ok, first.error).toBe(true)
    expect(second.ok, second.error).toBe(true)
    // 只同步一次 = 只有一次写入过程。
    expect(syncCalls).toBe(1)
    // 只产生一份备份。
    expect(readdirSync(join(w.data, 'pre-update'))).toHaveLength(1)
    expect(second.backupPath).toBe(first.backupPath)
  })

  /** 并发窗口结束后要能重新开始 —— 合并的只是「同时进行中的那一次」。 */
  it('并发窗口过后再更新会另起一次（不永久锁死）', async () => {
    const w = world()
    point(w)
    serve(gzipSync(Buffer.from('fake tarball')))
    const first = await installVersion(version)
    expect(first.ok, first.error).toBe(true)
    const second = await installVersion(version)
    expect(second.ok, second.error).toBe(true)
    expect(second.backupPath).not.toBe(first.backupPath)
    expect(readdirSync(join(w.data, 'pre-update'))).toHaveLength(2)
  })

  /** 并发时失败也要一致：两个人看到同一个失败，而不是一个成功一个回滚。 */
  it('并发更新失败时两次拿到同一条错误，备份只有一份', async () => {
    const w = world()
    point(w)
    const beforePkg = readFileSync(join(w.profile, 'package.json'), 'utf8')
    serve(gzipSync(Buffer.from('fake tarball')))
    setSyncImplementationForTest(async () => {
      await new Promise<void>(done => { setTimeout(done, 50) })
      return { ok: false, detail: 'pnpm 退出码 1' }
    })
    const [first, second] = await Promise.all([installVersion(version), installVersion(version)])
    expect(first.ok).toBe(false)
    expect(second.ok).toBe(false)
    expect(second.error).toBe(first.error)
    expect(readdirSync(join(w.data, 'pre-update'))).toHaveLength(1)
    expect(readFileSync(join(w.profile, 'package.json'), 'utf8')).toBe(beforePkg)
  })

  setSyncImplementationForTest(async () => ({ ok: true, detail: 'test stub' }))
})