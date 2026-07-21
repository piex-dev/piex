/**
 * Node.js polyfill for Bun APIs used by @oh-my-pi/hashline.
 * Injects Bun globals before the hashline module is loaded.
 */

import * as fsp from "node:fs/promises";
import * as fsSync from "node:fs";
import * as crypto from "node:crypto";

// ---------------------------------------------------------------------------
// xxHash32 implementation (pure JS, compatible with Bun.hash.xxHash32).
// Also exported for patches.ts (payloadKey / fileHash fingerprinting).
// ---------------------------------------------------------------------------

// xxHash32 constants
const PRIME32_1 = 0x9e3779b1;
const PRIME32_2 = 0x85ebca77;
const PRIME32_3 = 0xc2b2ae3d;
const PRIME32_4 = 0x27d4eb2f;
const PRIME32_5 = 0x165667b1;

function xxHash32(data: string, seed: number = 0): number {
  const buf = Buffer.from(data, "utf-8");
  const len = buf.length;
  let h32: number;

  if (len >= 16) {
    const limit = len - 16;
    let v1 = (seed + PRIME32_1 + PRIME32_2) >>> 0;
    let v2 = (seed + PRIME32_2) >>> 0;
    let v3 = seed >>> 0;
    let v4 = (seed - PRIME32_1) >>> 0;

    for (let i = 0; i <= limit; i += 16) {
      v1 = round(v1, buf.readUInt32LE(i));
      v2 = round(v2, buf.readUInt32LE(i + 4));
      v3 = round(v3, buf.readUInt32LE(i + 8));
      v4 = round(v4, buf.readUInt32LE(i + 12));
    }

    h32 = rotl32(v1, 1) + rotl32(v2, 7) + rotl32(v3, 12) + rotl32(v4, 18);
  } else {
    h32 = (seed + PRIME32_5) >>> 0;
  }

  h32 = (h32 + len) >>> 0;

  let remaining = len - (len & ~15);
  let offset = len - remaining;
  while (remaining >= 4) {
    h32 = (h32 + buf.readUInt32LE(offset) * PRIME32_3) >>> 0;
    h32 = rotl32(h32, 17) * PRIME32_4;
    offset += 4;
    remaining -= 4;
  }

  while (offset < len) {
    h32 = (h32 + buf[offset] * PRIME32_5) >>> 0;
    h32 = rotl32(h32, 11) * PRIME32_1;
    offset++;
  }

  h32 ^= h32 >>> 15;
  h32 = (h32 * PRIME32_2) >>> 0;
  h32 ^= h32 >>> 13;
  h32 = (h32 * PRIME32_3) >>> 0;
  h32 ^= h32 >>> 16;
  return h32 >>> 0;
}

function rotl32(x: number, r: number): number {
  return ((x << r) | (x >>> (32 - r))) >>> 0;
}

function round(acc: number, input: number): number {
  acc = (acc + input * PRIME32_2) >>> 0;
  acc = rotl32(acc, 13);
  return (acc * PRIME32_1) >>> 0;
}

// ---------------------------------------------------------------------------
// Bun global polyfill
// ---------------------------------------------------------------------------

interface PolyfillBunFile {
  exists(): Promise<boolean>;
  text(): Promise<string>;
}

const _Bun: Record<string, unknown> = {};

_Bun.file = function (filePath: string): PolyfillBunFile {
  return {
    async exists(): Promise<boolean> {
      try {
        await fsp.access(filePath);
        return true;
      } catch {
        return false;
      }
    },
    async text(): Promise<string> {
      return fsp.readFile(filePath, "utf-8");
    },
  };
};

_Bun.write = async function (filePath: string, content: string): Promise<void> {
  await fsp.writeFile(filePath, content, "utf-8");
};

_Bun.hash = {
  xxHash32(data: string, seed: number): number {
    return xxHash32(data, seed ?? 0);
  },
};

_Bun.env = process.env;
_Bun.version = "polyfill";
_Bun.sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Inject Bun global BEFORE any hashline import
// ---------------------------------------------------------------------------

if (typeof globalThis.Bun === "undefined") {
  (globalThis as unknown as Record<string, unknown>).Bun = _Bun;
}

export { _Bun, xxHash32 };
