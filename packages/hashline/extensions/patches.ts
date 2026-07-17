/**
 * Phase 1 — 模型行为容错层
 *
 * 两个正交的保护机制，状态由单个 EditGuard 统一管理，在 patcher 外层实现：
 *
 * 机制一 Noop Loop Guard — 模型忽略 noop hint，在 byte-identical 结果上反复重试。
 *   计数器方案：同一 (path, payloadKey) 连续 noop ≥ 3 次 → 抛 ToolError。
 *   参考 pi-hashline-edit src/noop-loop-guard.ts
 *
 * 机制二 Duplicate Edit Guard — 模型一次成功 edit 后误以为失败，重发相同 payload
 *   导致内容重复（如 append 一行后不确定是否生效，再发一次）。
 *   记录最后一次成功应用的 payload，新请求 payload 匹配 + 文件未变化 → 抛错。
 *   参考 pi-hashline-edit src/edit.ts execute() 中的 isDuplicateAppliedPayload
 */

import { xxHash32 } from "./bun-polyfill.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 同一 payload 连续 noop 超过此次数则抛错 */
export const NOOP_HARD_LIMIT = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 对 hashline DSL 输入生成紧凑的 payloadKey（xxHash32 的 hex 表示） */
export function computePayloadKey(input: string): string {
  return xxHash32(input, 0).toString(16).padStart(8, "0");
}

/** 对文件内容生成 fileHash，用于判断文件是否在两次 edit 之间被外部修改 */
export function computeFileHash(content: string): string {
  return xxHash32(content, 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// EditGuard — 统一管理 noop 循环计数与 duplicate 检测状态
// ---------------------------------------------------------------------------

interface NoopEntry {
  payloadKey: string;
  count: number;
}

interface AppliedEntry {
  payloadKey: string;
  fileHash: string;
}

export class EditGuard {
  private noopTracker = new Map<string, NoopEntry>();
  private appliedTracker = new Map<string, AppliedEntry>();

  /**
   * 记录一次 noop 编辑。payloadKey 变化时自动重置计数（模型换了 payload = 在尝试别的）。
   * 返回当前计数 + 是否触发硬限制。
   */
  recordNoop(path: string, payloadKey: string): {
    count: number;
    escalate: boolean;
  } {
    const existing = this.noopTracker.get(path);
    if (existing && existing.payloadKey === payloadKey) {
      existing.count += 1;
    } else {
      this.noopTracker.set(path, { payloadKey, count: 1 });
    }
    const count = this.noopTracker.get(path)!.count;
    return { count, escalate: count >= NOOP_HARD_LIMIT };
  }

  /**
   * 记录一次成功应用的编辑。清除 noop 计数，记录 payload + 文件哈希供
   * duplicate edit 检测使用。
   */
  recordApplied(path: string, payloadKey: string, fileHash: string): void {
    this.noopTracker.delete(path);
    this.appliedTracker.set(path, { payloadKey, fileHash });
  }

  /**
   * 判断新请求是否与上一次成功编辑的 payload 相同。
   * 调用方还需验证文件内容未变才能认定为 duplicate。
   */
  isDuplicateApplied(path: string, payloadKey: string): boolean {
    return this.appliedTracker.get(path)?.payloadKey === payloadKey;
  }

  /**
   * 获取上一次成功编辑后记录的文件哈希。
   * 返回 null 表示没有记录（该路径从未被成功编辑）。
   */
  getLastFileHash(path: string): string | null {
    return this.appliedTracker.get(path)?.fileHash ?? null;
  }

  /**
   * 用户在两次编辑之间主动 re-read 了文件 → 重置该路径的全部 guard 状态
   * （noop 计数 + applied 记录）。模型看到最新内容后有意重发同一 payload
   * 是合法的，noop 计数也应从头开始。
   */
  resetPath(path: string): void {
    this.noopTracker.delete(path);
    this.appliedTracker.delete(path);
  }
}
