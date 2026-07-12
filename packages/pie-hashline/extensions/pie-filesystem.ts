/**
 * PieNodeFilesystem — Node.js-native filesystem adapter for the hashline
 * Patcher. Uses `node:fs` APIs directly, eliminating the Bun polyfill for
 * file I/O (Bun.hash.xxHash32 polyfill remains necessary for computeFileHash).
 *
 * Key responsibilities beyond bare NodeFilesystem:
 *
 * - canonicalPath resolves symlinks via `fs.realpathSync.native()` so the
 *   snapshot store key matches `canonicalSnapshotKey` from the read hook.
 * - preflightWrite guards against unwritable paths before the patcher
 *   commits, surfacing permission errors at prepare-time.
 */

import * as fsSync from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { Filesystem, NotFoundError, isNotFound } from "@oh-my-pi/hashline";

// ---------------------------------------------------------------------------
// canonicalSnapshotKey — exported for use by both FS and snapshot recording
// ---------------------------------------------------------------------------

/**
 * Resolve an authored or tool-supplied file path into the canonical key the
 * snapshot store and patcher use. Must match exactly between the read hook
 * (which mints snapshots) and the edit tool (which looks them up).
 *
 * Strategy:
 * 1. realpath — resolves symlinks (e.g. macOS `/tmp` → `/private/tmp`).
 * 2. parent realpath + basename — for new / not-yet-created files.
 * 3. absolute fallback — last resort when neither works.
 */
export function canonicalSnapshotKey(absolutePath: string): string {
  try {
    return fsSync.realpathSync.native(absolutePath);
  } catch {
    try {
      const parent = fsSync.realpathSync.native(path.dirname(absolutePath));
      return path.join(parent, path.basename(absolutePath));
    } catch {
      return absolutePath;
    }
  }
}

// ---------------------------------------------------------------------------
// PieNodeFilesystem
// ---------------------------------------------------------------------------

export class PieNodeFilesystem extends Filesystem {
  constructor(_worktree: string) {
    super();
  }

  /**
   * Read raw text content of a path (absolute or worktree-relative).
   * Throws NotFoundError on ENOENT.
   */
  async readText(filePath: string): Promise<string> {
    try {
      return await fsp.readFile(filePath, "utf-8");
    } catch (error) {
      if (isNotFound(error)) throw new NotFoundError(filePath, error);
      throw error;
    }
  }

  /**
   * Write text content to disk. BOM/line-ending normalization is handled
   * by the patcher, not the FS layer.
   */
  async writeText(filePath: string, content: string): Promise<{ text: string }> {
    await fsp.writeFile(filePath, content, "utf-8");
    return { text: content };
  }

  /**
   * Delete a file. Throw NotFoundError when not found.
   */
  async delete(filePath: string): Promise<void> {
    try {
      await fsp.rm(filePath);
    } catch (error) {
      if (isNotFound(error)) throw new NotFoundError(filePath, error);
      throw error;
    }
  }

  /**
   * Canonical key for the snapshot store. Resolves symlinks so read-hook
   * snapshots and edit-tool lookups agree on the same store key.
   */
  canonicalPath(filePath: string): string {
    return canonicalSnapshotKey(filePath);
  }

  /**
   * Preflight check: ensure the target path (or its parent dir) is writable
   * before the patcher starts committing. Fails fast instead of mid-batch.
   */
  async preflightWrite(filePath: string): Promise<void> {
    try {
      await fsp.access(filePath, fsSync.constants.W_OK);
    } catch {
      // Not writable as a file — check parent directory
      try {
        await fsp.access(path.dirname(filePath), fsSync.constants.W_OK);
      } catch (err) {
        throw new Error(`Directory not writable: ${path.dirname(filePath)}`);
      }
    }
  }
}
