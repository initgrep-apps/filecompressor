import { describe, it } from "vitest";

export const DARWIN_ONLY_REASON =
  "darwin-only tooling (clang/lipo/brew); logic equivalent covered by portable PE/arch tests";

const isWin32 = process.platform === "win32";

export const itDarwin = isWin32
  ? Object.assign(
      (name, fn, timeout) => it.skip(`${name} (skipped: ${DARWIN_ONLY_REASON})`, fn, timeout),
      { each: (table) => it.skip.each(table) },
    )
  : it;

export const describeDarwin = isWin32
  ? (name, fn) => describe.skip(`${name} (skipped: ${DARWIN_ONLY_REASON})`, fn)
  : describe;
