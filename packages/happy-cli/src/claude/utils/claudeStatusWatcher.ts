/**
 * 本地模式的 thinking（是否正在工作）状态监测
 *
 * 背景：happy 原先靠在 claude_local_launcher.cjs 里劫持 global.fetch 判断忙闲。
 * Claude Code 2.x 起改为原生二进制分发，launcher 只是它的父 node 进程，
 * 进程内的 fetch 补丁跨不过进程边界 —— 本地模式的 thinking 因此恒为 false，
 * 手机端只看到「在线」，看不到「正在工作」。
 *
 * 改为读取 Claude Code 自己维护的会话状态文件：
 *   ~/.claude/sessions/<pid>.json → { pid, sessionId, status, statusUpdatedAt }
 * 按 sessionId 匹配（而不是 pid —— claude 是 launcher 的子进程，happy 拿不到它的 pid）。
 *
 * 实测 2.1.220 的 status 语义：
 *   idle   空闲
 *   busy   正在工作，prompt 提交后 ~60ms 内翻转
 *   shell  偶发停留值，且观测到不会自愈
 *
 * 为什么不用 Stop hook：实测 ESC 中断时 Stop 根本不触发，而 status 能正确
 * 回到 idle。若用 hook 驱动，中断后 thinking 会永久卡在 true，
 * 手机端显示「永远在工作」，比现在的「永远空闲」更糟。
 *
 * 全模块贯穿一条原则：**任何不确定都必须落到 false**。
 * 少显示一个转圈可以接受；卡在「正在工作」不可接受 —— 后者比修复前更糟。
 * 下面几处刻意的保守取舍都源于此：未知 status 判 false、会话切换即归零、
 * 状态文件持续读不到即归零、优先采信存活进程的文件。
 */

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "@/ui/logger";

/** Claude Code 认定「正在工作」的 status 取值 */
const BUSY_STATUS = "busy";

const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * 连续多少轮读不到状态文件才判定为「不在工作」。
 * 留几轮宽限是因为文件可能正被原子替换（rename 的瞬间可能扫不到），
 * 单次读取失败不该让状态抖动；但也不能无限期沿用旧值，否则会话 id 一变
 * 就永久卡在 true。
 */
const MISSING_FILE_GRACE_POLLS = 3;

function claudeSessionsDir(): string {
  const claudeConfigDir =
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return join(claudeConfigDir, "sessions");
}

/** 进程是否还活着。EPERM 说明进程存在但不属于我们，同样算活。 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

/** 存活优先级：存活 > 无法判断 > 已死。同级再比时间戳。 */
function livenessRank(pid: unknown): number {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return 1; // 没有可用的 pid，无法判断
  }
  return isProcessAlive(pid) ? 2 : 0;
}

/**
 * 在 ~/.claude/sessions 中按 sessionId 找到对应会话文件的 status。
 * 找不到（会话文件还没写出来 / 已被清理）返回 null。
 *
 * 会话文件按 pid 命名，且进程退出后不会被清理。若 claude 在工作中被杀，
 * 残留文件会永远停在 status=busy；之后同一个 sessionId 被 resume、由新 pid
 * 接管时，目录里就有两个文件匹配同一 sessionId。
 *
 * 只按 statusUpdatedAt 取最大值不足以排除残留文件：时间戳大小并不代表进程
 * 还活着。真实反例 —— 存活进程在 T2 落到 idle 后时间戳就停止前进，另一个
 * 进程在 T3>T2 翻到 busy 后被 SIGKILL，于是残留的 busy@T3 会永远胜出，
 * 手机端永久「正在工作」。所以先按进程存活性分级，再比时间戳。
 */
async function readStatusForSession(sessionId: string): Promise<string | null> {
  const dir = claudeSessionsDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }

  const candidates = await Promise.all(
    files
      .filter((name) => name.endsWith(".json"))
      .map(async (name) => {
        try {
          const raw = await readFile(join(dir, name), "utf-8");
          const parsed = JSON.parse(raw) as {
            pid?: unknown;
            sessionId?: unknown;
            status?: unknown;
            statusUpdatedAt?: unknown;
            updatedAt?: unknown;
          };
          if (
            parsed.sessionId !== sessionId ||
            typeof parsed.status !== "string"
          ) {
            return null;
          }
          // Number.isFinite 挡掉 Infinity / NaN：1e999 会被 JSON.parse 解析成
          // Infinity 且 typeof 仍是 number，若直接参与比较，Infinity > Infinity
          // 为 false，排序会被永久钉在第一个损坏的文件上。
          const at = Number.isFinite(parsed.statusUpdatedAt)
            ? (parsed.statusUpdatedAt as number)
            : Number.isFinite(parsed.updatedAt)
              ? (parsed.updatedAt as number)
              : -Infinity;
          return {
            status: parsed.status,
            at,
            liveness: livenessRank(parsed.pid),
          };
        } catch {
          // 半写状态的文件 / 非法 JSON：跳过，下一轮再看
          return null;
        }
      }),
  );

  let best: { status: string; at: number; liveness: number } | null = null;
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    if (
      best === null ||
      candidate.liveness > best.liveness ||
      (candidate.liveness === best.liveness && candidate.at > best.at)
    ) {
      best = candidate;
    }
  }
  return best?.status ?? null;
}

export interface ClaudeStatusWatcherOptions {
  /** 取当前 Claude 会话 id；启动时可能还不知道（等 SessionStart hook），返回 null 即视为不在工作 */
  getSessionId: () => string | null;
  /** 仅在状态发生变化时回调 */
  onThinkingChange: (thinking: boolean) => void;
  pollIntervalMs?: number;
}

/**
 * 轮询 Claude Code 会话状态文件，把 busy/其他 映射成 thinking 的 true/false。
 * 返回停止函数；停止时会强制回落到 thinking=false，避免退出瞬间把状态留在「工作中」。
 */
export function startClaudeStatusWatcher(
  opts: ClaudeStatusWatcherOptions,
): () => void {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let stopped = false;
  let lastThinking = false;
  let polling = false;
  let lastSessionId: string | null = null;
  let missingPolls = 0;

  // 统一出口：只在真正变化时上报，便于所有「归零」路径复用
  const applyThinking = (thinking: boolean, reason: string) => {
    if (thinking === lastThinking) {
      return;
    }
    lastThinking = thinking;
    logger.debug(`[ClaudeStatusWatcher] ${reason} → thinking=${thinking}`);
    opts.onThinkingChange(thinking);
  };

  const tick = async () => {
    // 上一轮还没读完就跳过，避免慢磁盘下堆积
    if (stopped || polling) {
      return;
    }
    polling = true;
    try {
      const sessionId = opts.getSessionId();

      // 会话切换（SessionStart hook 换了 id）或被 /clear 清空：旧会话的
      // thinking 不能顺延给新会话，否则新会话没有任何匹配文件时会永久
      // 卡在 true。
      if (sessionId !== lastSessionId) {
        lastSessionId = sessionId;
        missingPolls = 0;
        applyThinking(false, "session changed");
      }

      if (!sessionId) {
        return;
      }

      const status = await readStatusForSession(sessionId);

      // await 期间可能已被停止。此时 stop() 的兜底可能因为 lastThinking
      // 恰为 false 而没触发，若继续走下去就会在 launcher 生命周期的最后
      // 补发一次 thinking=true，把手机端永久钉在「正在工作」。
      if (stopped) {
        return;
      }

      if (status === null) {
        missingPolls++;
        if (missingPolls >= MISSING_FILE_GRACE_POLLS) {
          applyThinking(false, "status file missing");
        }
        return;
      }
      missingPolls = 0;
      applyThinking(status === BUSY_STATUS, `status=${status}`);
    } catch (error) {
      logger.debug("[ClaudeStatusWatcher] poll failed:", error);
    } finally {
      polling = false;
    }
  };

  const interval = setInterval(() => {
    void tick();
  }, pollIntervalMs);
  void tick();

  return () => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(interval);
    applyThinking(false, "stopped");
    logger.debug("[ClaudeStatusWatcher] stopped");
  };
}
