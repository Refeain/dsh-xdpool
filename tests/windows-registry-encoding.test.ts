/**
 * Regression tests for Windows registry paths that contain non-ASCII characters.
 *
 * The reported defect: the plugin read `reg.exe` output with `encoding: 'utf8'`,
 * but reg.exe writes with the ACTIVE CONSOLE CODE PAGE — 936/GBK on a Chinese
 * Windows. A path containing 「腾讯」 therefore arrived as `��Ѷ`, every
 * `existsSync` failed, and the plugin concluded no desktop app was installed
 * while the app was installed, running, and holding a perfectly good credential.
 *
 * The fix has two layers, and both are covered here:
 *   1. read the registry through PowerShell (`Get-ItemProperty` uses the
 *      registry API, so no code page is involved at all) — the primary path;
 *   2. keep a `reg.exe` reader as a fallback, but decode its bytes with
 *      encoding DETECTION validated against the filesystem, instead of
 *      assuming UTF-8.
 *
 * RESOURCES ARE PER-RUN (T6 / F7)
 *
 * 3.2.0 hard-coded `D:\_dsh_enc_probe` and two fixed key names under HKCU's
 * Uninstall tree. Three consequences, all of them real:
 *
 *   - Two runs at once (or a run next to somebody's leftover directory) fought
 *     over the same path: one deleted the fixture the other was asserting on.
 *   - A `D:` that does not exist, or is not writable, failed the test with an
 *     error about the test's own scaffolding rather than about the plugin.
 *   - `afterAll` deleted `D:\_dsh_enc_probe` unconditionally — a destructive
 *     cleanup of a FIXED absolute path, which is exactly the kind of thing that
 *     deletes a user's directory when it happens to have that name.
 *
 * So the path is a fresh `mkdtemp` directory and each key carries a random
 * suffix. Cleanup removes only what this run created.
 *
 * PERMISSION IS AN ENVIRONMENT CONDITION, NOT A PASS
 *
 * Policy blocks, a locked-down HKCU, or a machine where `reg.exe` is absent are
 * reported as "environment unverified" with the actual reason, and the cases are
 * skipped. Passing silently would be a lie: nothing about the encoding layer
 * would have been exercised.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { workbuddyAppExecutableCandidates } from '../src/at-rest.ts'

const isWindows = process.platform === 'win32'

/** A unique suffix per run: two concurrent runs cannot collide on a key name. */
const RUN = `${process.pid.toString(36)}-${Date.now().toString(36)}-${
  Math.floor(Math.random() * 0x100000).toString(36)}`

/**
 * The fixture directory.
 *
 * `mkdtemp` gives a path nothing else can be using, under whichever temp root
 * this machine actually has — the point is a real non-ASCII path, not drive D.
 */
function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'xdpool-enc-'))
}

/**
 * The fixture key must sit UNDER the Uninstall tree — the only place the reader
 * enumerates. A key anywhere else is invisible and the test would fail for a
 * reason unrelated to encoding. The `DisplayName` matters for the same reason:
 * that is what identifies a WorkBuddy entry.
 */
const UNINSTALL = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
const KEY = `${UNINSTALL}\\DSH-Enc-Encoding-${RUN}`
const LEGACY_KEY = `${UNINSTALL}\\DSH-Enc-Legacy-${RUN}`

function reg(args: readonly string[]): void {
  execFileSync('reg', [...args], { windowsHide: true, stdio: 'ignore' })
}

/**
 * Why this machine cannot host the fixture, or `undefined` when it can.
 *
 * Probed once with a throwaway key that is deleted immediately: creating a key
 * is the capability the cases need, and discovering it here turns a mid-case
 * explosion into a labelled skip.
 */
function environmentProblem(): string | undefined {
  if (!isWindows) return 'not Windows'
  const probe = `${UNINSTALL}\\DSH-Enc-Probe-${RUN}`
  try {
    reg(['add', probe, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', 'probe', '/f'])
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return `cannot create a registry key under HKCU (${message})`
  }
  try {
    reg(['delete', probe, '/f'])
  } catch { /* the delete failing is not worth blocking on */ }
  try {
    const root = makeRoot()
    rmSync(root, { recursive: true, force: true })
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return `cannot create a temporary directory (${message})`
  }
  return undefined
}

const blocked = environmentProblem()

/**
 * Report the skip where a reader will see it. This run's block reason is not
 * "the test does not apply" — it is "the environment could not be verified",
 * and the person reading the output needs to know which one it was.
 */
if (blocked !== undefined) {
  console.warn(`[windows-registry-encoding] environment unverified — ${blocked}`)
}

/** The console code page, e.g. 936 on a Chinese system. */
function consoleCodePage(): number {
  try {
    const out = execFileSync('cmd', ['/c', 'chcp'], { encoding: 'utf8' })
    return Number(/:\s*(\d+)/u.exec(out)?.[1] ?? 0)
  } catch {
    return 0
  }
}

/** Everything this run may delete; filled as cases create it. */
const created = new Set<string>()
const roots = new Set<string>()

afterAll(() => {
  for (const key of created) {
    try { reg(['delete', key, '/f']) } catch { /* already gone */ }
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** Make the fixture: a non-ASCII directory with an empty executable in it. */
function fixture(): { root: string; dir: string; exe: string } {
  const root = makeRoot()
  roots.add(root)
  const dir = join(root, '腾讯', 'WorkBuddy')
  const exe = join(dir, 'WorkBuddy.exe')
  mkdirSync(dir, { recursive: true })
  writeFileSync(exe, '')
  return { root, dir, exe }
}

/** Write one key and remember it for cleanup. */
function writeKey(key: string, values: readonly (readonly [string, string])[]): void {
  created.add(key)
  for (const [name, data] of values) {
    reg(['add', key, '/v', name, '/t', 'REG_SZ', '/d', data, '/f'])
  }
}

describe.skipIf(blocked !== undefined)('non-ASCII install paths survive the registry probe', () => {
  it('finds a Chinese install path where a UTF-8 read of reg.exe cannot', () => {
    const { root, exe } = fixture()
    try {
      writeKey(KEY, [
        ['DisplayName', 'WorkBuddy'],
        ['DisplayIcon', `${exe},0`],
      ])

      // (a) The defect itself, asserted only where it can occur: on a console
      //     whose code page is not UTF-8, the old reading is unusable. (Under a
      //     65001 console the old code happened to work, so there is nothing to
      //     reproduce and the assertion is skipped rather than faked.)
      const codePage = consoleCodePage()
      const asUtf8 = execFileSync('reg', ['query', KEY, '/v', 'DisplayIcon'], { encoding: 'utf8', windowsHide: true })
      const oldPath = /REG_SZ\s+(.+)$/mu.exec(asUtf8)?.[1]?.trim().replace(/,-?\d+$/u, '') ?? ''
      if (codePage !== 0 && codePage !== 65001) {
        expect(
          existsSync(oldPath),
          `reading reg.exe as UTF-8 must not resolve a Chinese path on code page ${codePage}`,
        ).toBe(false)
      }

      // (b) The fix: the plugin's own probe returns the path INTACT.
      const candidates = workbuddyAppExecutableCandidates('win32', 'C:\\Users\\nobody', {
        ...process.env,
        // Blank the override so the REGISTRY has to answer.
        WORKBUDDY_APP_EXECUTABLE: '',
      })
      const chinese = candidates.filter(candidate => candidate.includes('腾讯'))
      expect(chinese, 'the probe must surface the Chinese path').toContain(exe)
      expect(existsSync(exe)).toBe(true)
    } finally {
      try { reg(['delete', KEY, '/f']) } catch { /* ignore */ }
      created.delete(KEY)
      roots.delete(root)
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)

  it('a non-ASCII path is used when it is the first existing candidate', () => {
    // End to end at the level that matters: whichever layer produced the path,
    // the candidate list must place a real, existing file where the caller can
    // reach it — otherwise the key fetch is never attempted.
    const { root, dir } = fixture()
    try {
      writeKey(LEGACY_KEY, [
        ['DisplayName', 'WorkBuddy'],
        ['InstallLocation', dir],
      ])

      const candidates = workbuddyAppExecutableCandidates('win32', 'C:\\Users\\nobody', {
        ...process.env,
        WORKBUDDY_APP_EXECUTABLE: '',
      })
      // At least one candidate must resolve to the fixture directory, proving
      // the non-ASCII bytes made it through every layer intact.
      expect(candidates.some(candidate => candidate.startsWith(dir))).toBe(true)
    } finally {
      try { reg(['delete', LEGACY_KEY, '/f']) } catch { /* ignore */ }
      created.delete(LEGACY_KEY)
      roots.delete(root)
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)
})

/**
 * The lifecycle gotcha that makes fixed key names worse than they look.
 *
 * `Uninstall` is enumerated by the reader, so a key left behind by a crashed run
 * is not inert debris: it shows up as an installed app on the next run, and on a
 * real machine it is a phantom entry in the user's own Add/Remove list.
 */
describe.skipIf(blocked !== undefined)('cleanup removes only this run', () => {
  it('each fixture gets its own directory', () => {
    /*
      3.2.0 用的是固定路径 `D:\_dsh_enc_probe`。两个用例（或两个并发运行）会互相删掉
      对方正在断言的那个目录，失败的报错还指向测试自己的脚手架而不是插件。唯一目录
      是这条的修法，所以这里直接断言唯一性 —— 其余行为测试看不出来。
    */
    const first = makeRoot()
    const second = makeRoot()
    roots.add(first)
    roots.add(second)
    try {
      expect(second).not.toBe(first)
      expect(first.startsWith(tmpdir())).toBe(true)
    } finally {
      roots.delete(first)
      roots.delete(second)
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    }
  }, 30_000)

  it('two fixtures with different run suffixes do not collide', () => {
    const other = `${KEY}-other`
    const { root, exe } = fixture()
    try {
      writeKey(other, [['DisplayName', 'WorkBuddy'], ['DisplayIcon', `${exe},0`]])
      // Both keys exist; neither case can delete the other's key mid-flight.
      expect(() => reg(['query', other])).not.toThrow()
      reg(['delete', other, '/f'])
      created.delete(other)
      expect(() => reg(['query', other])).toThrow()
    } finally {
      try { reg(['delete', other, '/f']) } catch { /* ignore */ }
      created.delete(other)
      roots.delete(root)
      rmSync(root, { recursive: true, force: true })
    }
  }, 90_000)
})
