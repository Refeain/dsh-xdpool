/**
 * T1 三项收尾的接线守卫。
 *
 * 行为测试（`tests/pre-update-backup.test.ts`）证明「并发调用只建一份备份」这类结果；
 * 这里补的是另一类事实 —— 结果之所以成立，是因为代码里有那个结构。两者不能互相替代：
 * 行为测试在实现被换成「每次都串行 await」时仍可能通过，而结构一旦被删掉，
 * 未来的修改会把互斥、错误码判定、诚实提示一起带走。
 *
 * 三件事各对应一条被指出的问题：
 * 1. 同一 profile 的更新必须合并（`POST /plugins/dsh-xdpool/update` 可并发）；
 * 2. 快照只把 ENOENT/ENOTDIR 当「不存在」，其余读取错误要停下来；
 * 3. 失败提示不得声称「插件和数据都没有改动」——同步阶段可能已经动过 node_modules。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const install = readFileSync(new URL('../src/update-install.ts', import.meta.url), 'utf8')
const webStatus = readFileSync(new URL('../src/web-status.ts', import.meta.url), 'utf8')

/** 去掉块注释与行注释，避免"注释里写了就算通过"。 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

const installCode = codeOnly(install)
const webStatusCode = codeOnly(webStatus)

describe('同一 profile 的更新互斥', () => {
  it('installVersion 走 coalesceByProfile，而不是直接干活', () => {
    expect(installCode).toContain('return await coalesceByProfile(profile, () => installIntoProfile(profile, version))')
  })

  it('合并表按 profile 归一化后作键，并在结束时清掉', () => {
    expect(installCode).toContain('const inFlightInstalls = new Map<string, Promise<InstallResult>>()')
    // 键要 resolve；Windows 上还要折叠大小写，否则同一个目录的两个写法会各开一个窗口。
    expect(installCode).toContain('const absolute = resolve(profile)')
    expect(installCode).toContain("process.platform === 'win32' ? absolute.toLowerCase() : absolute")
    // 后来者拿到的是**同一个** Promise，不是自己再跑一遍。
    expect(installCode).toContain('const running = inFlightInstalls.get(key)')
    expect(installCode).toContain('if (running !== undefined) return await running')
    // 结束即删，且只删自己那一次（防止后一次被前一次的 finally 清掉）。
    expect(installCode).toContain('if (inFlightInstalls.get(key) === started) inFlightInstalls.delete(key)')
  })

  it('真正干活的部分是独立函数 installIntoProfile', () => {
    expect(installCode).toContain('async function installIntoProfile(profile: string, version: string): Promise<InstallResult> {')
  })
})

describe('快照区分「不存在」与「读不出来」', () => {
  it('只有 ENOENT / ENOTDIR 算不存在', () => {
    expect(installCode).toContain("if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' }")
    expect(installCode).toContain("return { kind: 'unreadable', detail:")
  })

  it('三态类型，而不是 {existed,content}', () => {
    expect(installCode).toContain("type FileSnapshot =")
    expect(installCode).toContain("{ kind: 'present'; content: string }")
  })

  it('读不出来时在动任何文件之前就取消更新', () => {
    expect(installCode).toContain("if (lockBefore.kind === 'unreadable') {")
    expect(installCode).toContain('已取消更新（文件没有被改动）')
    // 快照必须在建备份之前取：失败时不该留下新备份，也不该挤掉旧备份。
    const lockAt = installCode.indexOf('const lockBefore = snapshotFile(lockPath)')
    const backupAt = installCode.indexOf('const backup = backupBeforeUpdate({')
    expect(lockAt).toBeGreaterThan(0)
    expect(backupAt).toBeGreaterThan(lockAt)
  })

  it('恢复时读不出来的快照不猜，直接算恢复失败', () => {
    expect(installCode).toContain("if (snapshot.kind === 'unreadable') {")
    expect(installCode).toContain('无法判断该恢复成什么')
  })
})

describe('失败提示不夸大已确认的范围', () => {
  it('不再出现「插件和数据都没有改动」这种承诺（同步阶段可能动过 node_modules）', () => {
    // 备份阶段失败仍可以说「都没有改动」——那时确实一个字节都没写。所以查的是同步失败分支。
    expect(installCode).not.toContain('安装依赖失败，已回滚，插件和数据都没有改动')
    expect(webStatusCode).not.toContain('插件和数据都没有改动')
  })

  it('同步失败的提示点明是哪两个文件、以及 node_modules 未确认', () => {
    expect(installCode).toContain('package.json 与 pnpm-lock.yaml 已恢复成更新前的样子')
    expect(installCode).toContain('node_modules 在同步过程中可能已被部分改动')
    expect(installCode).toContain('无法从插件侧确认')
    // 要给出可执行的下一步。
    expect(installCode).toMatch(/再点一次「更新」可以重试|重启 DSH/u)
  })

  it('回滚未完成时说的是「文件回滚未完成」并给出备份路径', () => {
    expect(installCode).toContain('且文件回滚未完成')
    expect(installCode).toContain('profile 的备份在 ${backupPath}')
  })

  it('路由层的兜底也说清无法确认状态，而不是宣称没动', () => {
    expect(webStatusCode).toContain('无法确认 profile 当前状态')
    expect(webStatusCode).toContain('重启 DSH')
  })
})
