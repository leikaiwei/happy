import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { startClaudeStatusWatcher } from "./claudeStatusWatcher";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 找一个确定不存在的 pid。
 *
 * 不能写死小 pid（如 111）—— 那在别的机器或重启后可能是真实的系统进程，
 * 会让存活性排序翻转，用例随机红绿。运行时探测才是确定的。
 */
const findDeadPid = (): number => {
  for (const candidate of [4194303, 999983, 888887, 777769, 666649]) {
    try {
      process.kill(candidate, 0);
    } catch (error: any) {
      // EPERM 说明进程存在但不属于我们，不算死
      if (error?.code !== "EPERM") {
        return candidate;
      }
    }
  }
  throw new Error("找不到确定已死的 pid，无法进行存活性测试");
};

/**
 * 这些用例锁住 claudeStatusWatcher 的核心语义。
 * 语义来源是对 Claude Code 2.1.220 的实测（见该模块头注释）。
 *
 * 贯穿的原则：任何不确定都必须落到 false。少显示一个转圈可以接受，
 * 卡在「正在工作」不可接受 —— 后者比修复前更糟。
 */
describe("startClaudeStatusWatcher", () => {
  let configDir: string;
  let sessionsDir: string;
  let stop: (() => void) | null = null;
  let prevConfigDir: string | undefined;

  const SESSION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const DEAD_PID = findDeadPid();

  // 写一个 Claude Code 形态的会话状态文件
  const writeSessionFile = (
    pid: number,
    status: string,
    sessionId = SESSION_ID,
  ) =>
    writeFile(
      join(sessionsDir, `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId,
        status,
        cwd: "/tmp",
        statusUpdatedAt: Date.now(),
      }),
    );

  beforeEach(async () => {
    configDir = join(
      tmpdir(),
      `csw-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    sessionsDir = join(configDir, "sessions");
    await mkdir(sessionsDir, { recursive: true });
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (stop) {
      stop();
      stop = null;
    }
    if (prevConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    }
    if (existsSync(configDir)) {
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("busy 触发 thinking=true，回到 idle 后归零", async () => {
    await writeSessionFile(DEAD_PID, "idle");
    const changes: boolean[] = [];
    stop = startClaudeStatusWatcher({
      getSessionId: () => SESSION_ID,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 30,
    });

    await sleep(120);
    expect(changes).toEqual([]); // 一直 idle：不应产生任何变化事件

    await writeSessionFile(DEAD_PID, "busy");
    await sleep(150);
    expect(changes).toEqual([true]);

    // ESC 中断的实际表现就是 status 回到 idle
    await writeSessionFile(DEAD_PID, "idle");
    await sleep(150);
    expect(changes).toEqual([true, false]);
  });

  it("只在状态变化时回调，busy 持续不重复上报", async () => {
    await writeSessionFile(DEAD_PID, "busy");
    const changes: boolean[] = [];
    stop = startClaudeStatusWatcher({
      getSessionId: () => SESSION_ID,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });

    await sleep(200);
    expect(changes).toEqual([true]);
  });

  it("未知 status（如 shell）保守判为不工作", async () => {
    await writeSessionFile(DEAD_PID, "busy");
    const changes: boolean[] = [];
    stop = startClaudeStatusWatcher({
      getSessionId: () => SESSION_ID,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    await sleep(120);
    expect(changes).toEqual([true]);

    // 实测出现过 busy → shell 且不自愈，必须按「不工作」处理，
    // 否则手机端会永远显示正在工作
    await writeSessionFile(DEAD_PID, "shell");
    await sleep(150);
    expect(changes).toEqual([true, false]);
  });

  it("sessionId 未知时不上报", async () => {
    await writeSessionFile(DEAD_PID, "busy");
    const changes: boolean[] = [];
    stop = startClaudeStatusWatcher({
      getSessionId: () => null,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    await sleep(150);
    expect(changes).toEqual([]);
  });

  it("忽略其他会话的状态文件", async () => {
    await writeSessionFile(DEAD_PID, "busy", "other-session-id");
    const changes: boolean[] = [];
    stop = startClaudeStatusWatcher({
      getSessionId: () => SESSION_ID,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    await sleep(150);
    expect(changes).toEqual([]);
  });

  it("会话文件一直不存在时保持不工作", async () => {
    const changes: boolean[] = [];
    stop = startClaudeStatusWatcher({
      getSessionId: () => SESSION_ID,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    await sleep(150);
    expect(changes).toEqual([]);
  });

  // 若「读不到文件」被当成「沿用上次状态」，而上次恰好是 busy，
  // 就会永久卡在「正在工作」。必须在若干轮宽限后归零。
  it("工作中状态文件消失，宽限若干轮后归零", async () => {
    await writeSessionFile(DEAD_PID, "busy");
    const changes: boolean[] = [];
    stop = startClaudeStatusWatcher({
      getSessionId: () => SESSION_ID,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    await sleep(120);
    expect(changes).toEqual([true]);

    await unlink(join(sessionsDir, `${DEAD_PID}.json`));
    await sleep(300);
    expect(changes).toEqual([true, false]);
  });

  // 会话 id 变了（SessionStart hook 换 id、或 /clear 清空），旧会话的
  // thinking 不能顺延 —— 否则新会话没有任何匹配文件时会永久卡在 true。
  it("会话 id 变化时立即归零", async () => {
    await writeSessionFile(DEAD_PID, "busy");
    const changes: boolean[] = [];
    let currentId: string | null = SESSION_ID;
    stop = startClaudeStatusWatcher({
      getSessionId: () => currentId,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    await sleep(120);
    expect(changes).toEqual([true]);

    currentId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    await sleep(150);
    expect(changes).toEqual([true, false]);
  });

  it("会话 id 被清空（/clear）时归零", async () => {
    await writeSessionFile(DEAD_PID, "busy");
    const changes: boolean[] = [];
    let currentId: string | null = SESSION_ID;
    stop = startClaudeStatusWatcher({
      getSessionId: () => currentId,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    await sleep(120);
    expect(changes).toEqual([true]);

    currentId = null;
    await sleep(150);
    expect(changes).toEqual([true, false]);
  });

  it("停止时把 thinking 归零", async () => {
    await writeSessionFile(DEAD_PID, "busy");
    const changes: boolean[] = [];
    // 同时赋给 stop：断言失败时 afterEach 仍能清掉 interval，
    // 否则泄漏的定时器会在 CLAUDE_CONFIG_DIR 还原后去扫真实目录
    const dispose = startClaudeStatusWatcher({
      getSessionId: () => SESSION_ID,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    stop = dispose;
    await sleep(120);
    expect(changes).toEqual([true]);

    dispose();
    // 重复停止必须安全
    dispose();
    stop = null;

    expect(changes).toEqual([true, false]);

    // 停止后不应再有任何事件
    await writeSessionFile(DEAD_PID, "busy");
    await sleep(120);
    expect(changes).toEqual([true, false]);
  });

  it("半写状态的非法 JSON 不影响后续读取", async () => {
    await writeFile(join(sessionsDir, "999.json"), '{"sessionId": "trunc');
    await writeSessionFile(DEAD_PID, "busy");
    const changes: boolean[] = [];
    stop = startClaudeStatusWatcher({
      getSessionId: () => SESSION_ID,
      onThinkingChange: (t) => {
        changes.push(t);
      },
      pollIntervalMs: 20,
    });
    await sleep(150);
    expect(changes).toEqual([true]);
  });

  // 会话文件按 pid 命名且退出后不清理：claude 在工作中被杀会留下永远
  // status=busy 的残留文件。同一 sessionId 被 resume 后目录里就有两个文件，
  // 选错就会把手机端永久钉在「正在工作」。
  describe("同一 sessionId 存在多个会话文件（进程被杀后残留）", () => {
    const writeAt = (
      pid: number,
      status: string,
      statusUpdatedAt: number,
      extra: Record<string, unknown> = {},
    ) =>
      writeFile(
        join(sessionsDir, `${pid}.json`),
        JSON.stringify({
          pid,
          sessionId: SESSION_ID,
          status,
          cwd: "/tmp",
          statusUpdatedAt,
          ...extra,
        }),
      );

    it("同为死进程时，按时间戳取较新的（残留 busy 不覆盖更新的 idle）", async () => {
      await writeAt(DEAD_PID, "busy", 1_000);
      await writeAt(DEAD_PID + 1, "idle", 9_000);
      const changes: boolean[] = [];
      stop = startClaudeStatusWatcher({
        getSessionId: () => SESSION_ID,
        onThinkingChange: (t) => {
          changes.push(t);
        },
        pollIntervalMs: 20,
      });
      await sleep(150);
      expect(changes).toEqual([]);
    });

    it("反向也成立：更新的 busy 胜过较旧的 idle", async () => {
      await writeAt(DEAD_PID, "idle", 1_000);
      await writeAt(DEAD_PID + 1, "busy", 9_000);
      const changes: boolean[] = [];
      stop = startClaudeStatusWatcher({
        getSessionId: () => SESSION_ID,
        onThinkingChange: (t) => {
          changes.push(t);
        },
        pollIntervalMs: 20,
      });
      await sleep(150);
      expect(changes).toEqual([true]);
    });

    // 关键场景：只比时间戳不足以排除残留文件。存活进程落到 idle 后时间戳
    // 就停止前进，而另一个进程在更晚的时刻翻到 busy 后被 SIGKILL，
    // 残留的 busy 会永远胜出。所以存活性优先于时间戳。
    it("存活进程的 idle 胜过死进程时间戳更新的 busy", async () => {
      await writeAt(DEAD_PID, "busy", 9_000); // 已死，但时间戳更新
      await writeAt(process.pid, "idle", 1_000); // 存活，时间戳更旧
      const changes: boolean[] = [];
      stop = startClaudeStatusWatcher({
        getSessionId: () => SESSION_ID,
        onThinkingChange: (t) => {
          changes.push(t);
        },
        pollIntervalMs: 20,
      });
      await sleep(150);
      expect(changes).toEqual([]);
    });

    it("存活进程的 busy 也胜过死进程更新的 idle", async () => {
      await writeAt(DEAD_PID, "idle", 9_000);
      await writeAt(process.pid, "busy", 1_000);
      const changes: boolean[] = [];
      stop = startClaudeStatusWatcher({
        getSessionId: () => SESSION_ID,
        onThinkingChange: (t) => {
          changes.push(t);
        },
        pollIntervalMs: 20,
      });
      await sleep(150);
      expect(changes).toEqual([true]);
    });

    // 1e999 会被 JSON.parse 解析成 Infinity 且 typeof 仍是 number；
    // 若直接参与比较，Infinity > Infinity 为 false，会被永久钉在损坏的文件上。
    it("时间戳为 Infinity 的损坏文件不会钉住选择", async () => {
      await writeFile(
        join(sessionsDir, `${DEAD_PID}.json`),
        `{"pid":${DEAD_PID},"sessionId":"${SESSION_ID}","status":"busy","statusUpdatedAt":1e999}`,
      );
      await writeAt(process.pid, "idle", 1_000);
      const changes: boolean[] = [];
      stop = startClaudeStatusWatcher({
        getSessionId: () => SESSION_ID,
        onThinkingChange: (t) => {
          changes.push(t);
        },
        pollIntervalMs: 20,
      });
      await sleep(150);
      // 存活进程的 idle 应当胜出，而不是被 Infinity 钉在 busy
      expect(changes).toEqual([]);
    });
  });
});
