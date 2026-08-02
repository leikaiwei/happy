import { InvalidateSync } from "@/utils/sync";
import { RawJSONLines, RawJSONLinesSchema } from "../types";
import { parseClaudeGoalStatusTranscriptEvent, type ClaudeGoalStatusTranscriptEvent } from "../claudeGoalStatus";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { logger } from "@/ui/logger";
import { startFileWatcher } from "@/modules/watcher/startFileWatcher";
import { getProjectPath } from "./path";

/**
 * Known internal Claude Code event types that should be silently skipped.
 * These are written to session JSONL files by Claude Code but are not 
 * actual conversation messages - they're internal state/tracking events.
 */
const INTERNAL_CLAUDE_EVENT_TYPES = new Set([
    'file-history-snapshot',
    'change',
    'queue-operation',
]);

export type ScannerTranscriptEvent = ClaudeGoalStatusTranscriptEvent;

type SessionLogEntry =
    | { kind: 'message'; key: string; message: RawJSONLines }
    | { kind: 'transcript-event'; key: string; event: ScannerTranscriptEvent }
    | { kind: 'title'; title: string };

/**
 * Claude Code 2.x 把它自己生成的会话标题写进 transcript：
 *   {"type":"ai-title","aiTitle":"...","sessionId":"..."}
 * 没有 uuid / timestamp，且同一标题会被反复写入（实测平均每个会话 ~59 次），
 * 所以不能套用基于 uuid 的去重，只能按「与上次已上报的标题是否相同」判断。
 *
 * 早期版本写的是 {"type":"summary"}，happy 至今只认那个 —— 这就是手机端
 * 标题停留在旧值的原因（最近的 transcript 里 summary 行数为 0）。
 */
function parseAiTitle(message: Record<string, unknown>): string | null {
    if (message.type !== 'ai-title') {
        return null;
    }
    const title = message.aiTitle;
    return typeof title === 'string' && title.trim().length > 0 ? title.trim() : null;
}

export async function createSessionScanner(opts: {
    sessionId: string | null,
    workingDirectory: string
    onMessage: (message: RawJSONLines) => void
    onTranscriptEvent?: (event: ScannerTranscriptEvent) => void
    /** Claude Code 自己生成/更新了会话标题时回调（已按值去重，只在变化时触发） */
    onTitle?: (title: string) => void
    /**
     * How long the transcript's parent directory may stay continuously
     * unwatchable before the watcher gives up and the session is dropped.
     * Defaults to the startFileWatcher default (60s). Exposed mainly so tests
     * can exercise the drop path quickly.
     *
     * Note this no longer bounds how long we wait for the transcript *file* —
     * that wait is unbounded on purpose, because Claude Code creates it lazily
     * on the first prompt. See startFileWatcher for the full rationale.
     */
    missingFileTimeoutMs?: number
}) {

    // Resolve project directory
    const projectDir = getProjectPath(opts.workingDirectory);

    // Finished, pending finishing and current session
    let finishedSessions = new Set<string>();
    let pendingSessions = new Set<string>();
    let currentSessionId: string | null = null;
    let watchers = new Map<string, (() => void)>();
    let processedEntryKeys = new Set<string>();
    // Sessions whose watcher gave up because the project directory itself
    // stayed unwatchable (missing, EACCES). Once dropped we must stop
    // re-reading them and never re-create a watcher, or the id keeps itself
    // alive forever via the watchers map below and floods the log (the
    // "dead Happy instance" bug).
    //
    // A merely absent transcript no longer lands here: Claude Code creates it
    // lazily on the first prompt, so the watcher waits for it indefinitely.
    // That makes this set rare in practice — a phantom id now costs one idle
    // directory watch for the lifetime of the process instead of being
    // blacklisted after 60s. See startFileWatcher for why that trade is right.
    let deadSessions = new Set<string>();
    // 上次已上报的会话标题。ai-title 无 uuid 且会重复写入，只能按值去重。
    let lastReportedTitle: string | null = null;

    // Mark existing entries as processed and start watching the initial session
    if (opts.sessionId) {
        let entries = await readSessionEntries(projectDir, opts.sessionId);
        logger.debug(`[SESSION_SCANNER] Marking ${entries.length} existing entries as processed from session ${opts.sessionId}`);
        for (let entry of entries) {
            // 标题不参与 key 去重（无 uuid），也不该被预标记吞掉：
            // resume 时正需要把磁盘上的当前标题推给手机端。
            if (entry.kind === 'title') {
                continue;
            }
            processedEntryKeys.add(entry.key);
        }
        // IMPORTANT: Also start watching the initial session file because Claude Code
        // may continue writing to it even after creating a new session with --resume
        // (agent tasks and other updates can still write to the original session file)
        currentSessionId = opts.sessionId;
    }

    // Main sync function
    const sync = new InvalidateSync(async () => {

        // Collect session ids - include ALL sessions that have watchers
        // This ensures we continue processing sessions that Claude Code may still write to
        let sessions: string[] = [];
        for (let p of pendingSessions) {
            if (!deadSessions.has(p)) {
                sessions.push(p);
            }
        }
        if (currentSessionId && !pendingSessions.has(currentSessionId) && !deadSessions.has(currentSessionId)) {
            sessions.push(currentSessionId);
        }
        // Also process sessions that have active watchers (they may still receive updates)
        for (let [sessionId] of watchers) {
            if (!sessions.includes(sessionId) && !deadSessions.has(sessionId)) {
                sessions.push(sessionId);
            }
        }

        // Process sessions
        for (let session of sessions) {
            const sessionEntries = await readSessionEntries(projectDir, session);
            let skipped = 0;
            let sentMessages = 0;
            let sentTranscriptEvents = 0;
            // 文件里最后一条 ai-title 才是当前标题，循环结束后统一上报，
            // 避免一次同步里把历史标题依次推上去造成闪烁。
            let latestTitle: string | null = null;
            for (let entry of sessionEntries) {
                // 标题不走 processedEntryKeys：ai-title 没有 uuid，只能按值去重
                if (entry.kind === 'title') {
                    latestTitle = entry.title;
                    continue;
                }
                if (processedEntryKeys.has(entry.key)) {
                    skipped++;
                    continue;
                }
                processedEntryKeys.add(entry.key);
                if (entry.kind === 'message') {
                    logger.debug(`[SESSION_SCANNER] Sending new message: type=${entry.message.type}, uuid=${entry.message.type === 'summary' ? entry.message.leafUuid : entry.message.uuid}`);
                    opts.onMessage(entry.message);
                    sentMessages++;
                } else {
                    logger.debug(`[SESSION_SCANNER] Sending new transcript event: type=${entry.event.type}, uuid=${entry.event.uuid}`);
                    opts.onTranscriptEvent?.(entry.event);
                    sentTranscriptEvents++;
                }
            }
            // 只上报当前会话的标题 —— resume 会留下旧会话文件，它们各自带着
            // 自己的 ai-title，若一并上报会每轮在新旧标题间来回翻。
            if (latestTitle !== null && session === currentSessionId && latestTitle !== lastReportedTitle) {
                lastReportedTitle = latestTitle;
                logger.debug(`[SESSION_SCANNER] Session title changed: ${latestTitle}`);
                opts.onTitle?.(latestTitle);
            }
            if (sessionEntries.length > 0) {
                logger.debug(`[SESSION_SCANNER] Session ${session}: found=${sessionEntries.length}, skipped=${skipped}, sentMessages=${sentMessages}, sentTranscriptEvents=${sentTranscriptEvents}`);
            }
        }

        // Move pending sessions to finished sessions (but keep processing them via watchers)
        for (let p of sessions) {
            if (pendingSessions.has(p)) {
                pendingSessions.delete(p);
                finishedSessions.add(p);
            }
        }

        // Update watchers for all sessions
        for (let p of sessions) {
            if (!watchers.has(p) && !deadSessions.has(p)) {
                logger.debug(`[SESSION_SCANNER] Starting watcher for session: ${p}`);
                watchers.set(p, startFileWatcher(
                    join(projectDir, `${p}.jsonl`),
                    () => { sync.invalidate(); },
                    {
                        missingFileTimeoutMs: opts.missingFileTimeoutMs,
                        onGaveUp: () => {
                            // The project directory itself stayed unwatchable,
                            // so we can never observe this transcript. Tear the
                            // watcher down and blacklist the session so the
                            // collection loop above stops resurrecting it.
                            // Without this it would keep itself in `watchers`
                            // forever. Note a merely late transcript does NOT
                            // reach here — that wait is unbounded by design.
                            logger.debug(`[SESSION_SCANNER] Session ${p} transcript unreachable (directory unwatchable) — dropping it`);
                            watchers.get(p)?.();
                            watchers.delete(p);
                            deadSessions.add(p);
                            pendingSessions.delete(p);
                        },
                    },
                ));
            }
        }
    });
    await sync.invalidateAndAwait();

    // Periodic sync
    const intervalId = setInterval(() => { sync.invalidate(); }, 3000);

    // Public interface
    return {
        cleanup: async () => {
            clearInterval(intervalId);
            // 顺序要紧：invalidateAndAwait 会真的再跑一遍 sync body，而 body 末尾
            // 会为每个没有 watcher 的会话新建 watcher。若先释放再 clear()，这最后
            // 一次同步会把它们全部重建，而随后的 sync.stop() 只置停止标志、不碰
            // watchers，且 map 已清空、外部再无入口 —— 这些 persistent 的 OS watch
            // 就永久无人释放。所以先冲刷并停掉 sync，再释放 watcher。
            await sync.invalidateAndAwait();
            sync.stop();
            for (let w of watchers.values()) {
                w();
            }
            watchers.clear();
        },
        onNewSession: async (sessionId: string, options?: { treatExistingAsProcessed?: boolean }) => {
            if (currentSessionId === sessionId) {
                logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is the same as the current session, skipping`);
                return;
            }
            // The caller explicitly re-announces this session, so give a
            // previously-dropped id another chance (its file may exist now).
            if (deadSessions.delete(sessionId)) {
                logger.debug(`[SESSION_SCANNER] Reviving previously-dropped session: ${sessionId}`);
            }
            // 这个 id 之前当过 current 或排过队。以前遇到这种情况直接 return，
            // 于是 currentSessionId 停在旧值 —— 而标题上报以它为唯一闸门，
            // 当前会话的 ai-title 会被永久丢弃（finishedSessions 只增不减，
            // 任何当过 current 的 id 都被永久毒化）。触发路径：A → resume 到 B
            // → claude 再次宣告 A（双 ESC fork 回去、--continue 落回原 id）。
            // 调用方在明确宣告「现在活跃的是它」，所以照常认领为 current。
            // 消息不会因此重放：去重靠只增的 processedEntryKeys（按 uuid），
            // 与这两个集合无关。
            if (finishedSessions.has(sessionId) || pendingSessions.has(sessionId)) {
                logger.debug(`[SESSION_SCANNER] Re-adopting previously tracked session as current: ${sessionId}`);
                finishedSessions.delete(sessionId);
                pendingSessions.delete(sessionId);
            }
            // When the caller already has these messages (typical for
            // happy-reconnect — the server holds the history from prior
            // turns and metadata.claudeSessionId simply hadn't propagated
            // by the time we built the scanner), pre-mark whatever is on
            // disk so the first invalidate() does not replay the entire
            // file as fresh user prompts. Without this, every previous
            // user message re-appears in the chat after reconnect.
            if (options?.treatExistingAsProcessed) {
                const existing = await readSessionEntries(projectDir, sessionId);
                logger.debug(`[SESSION_SCANNER] Pre-marking ${existing.length} existing entries as processed for new session ${sessionId}`);
                for (const entry of existing) {
                    // 同上：标题无 key，且重连后仍需把当前标题同步给手机端
                    if (entry.kind === 'title') {
                        continue;
                    }
                    processedEntryKeys.add(entry.key);
                }
            }
            if (currentSessionId) {
                pendingSessions.add(currentSessionId);
            }
            logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`)
            currentSessionId = sessionId;
            sync.invalidate();
        },
    }
}

export type SessionScanner = ReturnType<typeof createSessionScanner>;


//
// Helpers
//

function messageKey(message: RawJSONLines): string {
    if (message.type === 'user') {
        return message.uuid;
    } else if (message.type === 'assistant') {
        return message.uuid;
    } else if (message.type === 'summary') {
        return 'summary: ' + message.leafUuid + ': ' + message.summary;
    } else if (message.type === 'system') {
        return message.uuid;
    } else {
        throw Error() // Impossible
    }
}

function transcriptEventKey(event: ScannerTranscriptEvent): string {
    return `event:${event.uuid}`;
}

/**
 * Read and parse session log file
 * Returns only valid conversation messages and recognized side-channel events,
 * silently skipping internal events.
 */
async function readSessionEntries(projectDir: string, sessionId: string): Promise<SessionLogEntry[]> {
    const expectedSessionFile = join(projectDir, `${sessionId}.jsonl`);
    logger.debug(`[SESSION_SCANNER] Reading session file: ${expectedSessionFile}`);
    let file: string;
    try {
        file = await readFile(expectedSessionFile, 'utf-8');
    } catch (error) {
        logger.debug(`[SESSION_SCANNER] Session file not found: ${expectedSessionFile}`);
        return [];
    }
    let lines = file.split('\n');
    let entries: SessionLogEntry[] = [];
    for (let l of lines) {
        try {
            if (l.trim() === '') {
                continue;
            }
            let message = JSON.parse(l);
            
            // Silently skip known internal Claude Code events
            // These are state/tracking events, not conversation messages
            if (message.type && INTERNAL_CLAUDE_EVENT_TYPES.has(message.type)) {
                continue;
            }

            const aiTitle = parseAiTitle(message);
            if (aiTitle) {
                entries.push({ kind: 'title', title: aiTitle });
                continue;
            }

            const transcriptEvent = parseClaudeGoalStatusTranscriptEvent(message);
            if (transcriptEvent) {
                entries.push({
                    kind: 'transcript-event',
                    key: transcriptEventKey(transcriptEvent),
                    event: transcriptEvent,
                });
                continue;
            }
            
            let parsed = RawJSONLinesSchema.safeParse(message);
            if (!parsed.success) {
                // Unknown message types are silently skipped
                continue;
            }
            entries.push({
                kind: 'message',
                key: messageKey(parsed.data),
                message: parsed.data,
            });
        } catch (e) {
            logger.debug(`[SESSION_SCANNER] Error processing message: ${e}`);
            continue;
        }
    }
    return entries;
}
