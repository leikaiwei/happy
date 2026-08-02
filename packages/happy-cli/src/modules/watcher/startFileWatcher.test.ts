import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { startFileWatcher } from './startFileWatcher'
import { mkdir, writeFile, appendFile, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('startFileWatcher', () => {
  let testDir: string
  let stop: (() => void) | null = null

  beforeEach(async () => {
    testDir = join(tmpdir(), `fw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    if (stop) {
      stop()
      stop = null
    }
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  // 这是 Bug A 的回归测试。Claude Code 懒创建 transcript：用户启动后
  // 若迟迟不发第一条消息，文件就一直不存在。旧实现按时间上限放弃，
  // 会话被永久拉黑，手机端内容再也不同步。
  it('文件迟迟不出现也不放弃（只要父目录可监听）', async () => {
    const missing = join(testDir, 'never.jsonl')
    let changes = 0
    let gaveUp = 0

    stop = startFileWatcher(missing, () => { changes++ }, {
      missingFileTimeoutMs: 100,
      onGaveUp: () => { gaveUp++ },
    })

    // 远超 missingFileTimeoutMs：该超时只约束父目录不可监听的情况
    await sleep(1200)

    expect(gaveUp).toBe(0)
    expect(changes).toBe(0)
  })

  // 对应真实场景：用户 90 秒后才敲下第一条消息。这里用短超时证明
  // 等待文件创建与该超时无关。
  it('远超超时后才创建的文件仍能接上', async () => {
    const file = join(testDir, 'late.jsonl')
    let changes = 0
    let gaveUp = 0

    stop = startFileWatcher(file, () => { changes++ }, {
      missingFileTimeoutMs: 100,
      onGaveUp: () => { gaveUp++ },
    })

    await sleep(900)
    expect(gaveUp).toBe(0)

    await writeFile(file, 'line-1\n')
    await sleep(400)
    await appendFile(file, 'line-2\n')
    await sleep(400)

    expect(gaveUp).toBe(0)
    expect(changes).toBeGreaterThan(0)
  })

  it('文件一开始就存在时正常监听', async () => {
    const file = join(testDir, 'present.jsonl')
    await writeFile(file, 'init\n')

    let changes = 0
    let gaveUp = 0
    stop = startFileWatcher(file, () => { changes++ }, {
      missingFileTimeoutMs: 200,
      onGaveUp: () => { gaveUp++ },
    })

    await sleep(300)
    await appendFile(file, 'more\n')
    await sleep(400)

    expect(gaveUp).toBe(0)
    expect(changes).toBeGreaterThan(0)
  })

  it('文件被删除后重新出现能自愈', async () => {
    const file = join(testDir, 'recreated.jsonl')
    await writeFile(file, 'init\n')

    let changes = 0
    let gaveUp = 0
    stop = startFileWatcher(file, () => { changes++ }, {
      missingFileTimeoutMs: 100,
      onGaveUp: () => { gaveUp++ },
    })

    await sleep(200)
    await unlink(file)
    await sleep(600)

    await writeFile(file, 'reborn\n')
    await sleep(300)
    await appendFile(file, 'again\n')
    await sleep(400)

    expect(gaveUp).toBe(0)
    expect(changes).toBeGreaterThan(0)
  })

  // 保留的唯一放弃路径：父目录始终无法监听（不存在或无权限）。
  // 这才是原先超时真正该防的情况。
  it('父目录不可监听且超时后放弃一次', async () => {
    const missing = join(testDir, 'no-such-dir', 'ghost.jsonl')
    let changes = 0
    let gaveUp = 0

    stop = startFileWatcher(missing, () => { changes++ }, {
      missingFileTimeoutMs: 100,
      onGaveUp: () => { gaveUp++ },
    })

    await sleep(2500)

    expect(gaveUp).toBe(1)
    expect(changes).toBe(0)
  })

  it('dispose 后不再放弃也不再回调', async () => {
    const missing = join(testDir, 'aborted.jsonl')
    let changes = 0
    let gaveUp = 0

    const dispose = startFileWatcher(missing, () => { changes++ }, {
      missingFileTimeoutMs: 10_000,
      onGaveUp: () => { gaveUp++ },
    })

    await sleep(150)
    dispose()
    // 重复 dispose 必须安全
    dispose()
    stop = null

    await sleep(600)

    // dispose 之后创建文件也不应再触发回调
    await writeFile(missing, 'after-dispose\n')
    await sleep(300)

    expect(gaveUp).toBe(0)
    expect(changes).toBe(0)
  })
})
