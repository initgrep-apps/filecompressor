// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PeParseError, parsePeImports, peMachineName } from "./pe-imports.mjs";
import { buildPe } from "./fixtures/pe-fixture.mjs";

describe("parsePeImports", () => {
  it("reads every import dll name and the image machine of a PE64 image", () => {
    const pe = buildPe({
      importSpecs: [
        { dll: "libgs-10.dll", functions: [{ name: "gsapi_run_string" }, null] },
        { dll: "KERNEL32.dll", functions: [{ name: "LoadLibraryExW" }] },
      ],
    });
    const parsed = parsePeImports(pe);
    expect(parsed.machine).toBe(0x8664);
    expect(
      parsed.imports.map((entry) => ({ dll: entry.dll, ordinalOnly: entry.ordinalOnly })),
    ).toEqual([
      { dll: "libgs-10.dll", ordinalOnly: false },
      { dll: "KERNEL32.dll", ordinalOnly: false },
    ]);
  });

  it("reads ordinal-only thunks of a PE32 image", () => {
    const pe = buildPe({
      magic: 0x10b,
      importSpecs: [{ dll: "libfoo-1.dll", functions: [null, null] }],
    });
    const parsed = parsePeImports(pe);
    expect(parsed.machine).toBe(0x8664);
    expect(parsed.imports).toEqual([{ dll: "libfoo-1.dll", ordinalOnly: true }]);
  });

  it("reads an image whose import directory is absent", () => {
    const pe = buildPe({ importSpecs: [] });
    expect(parsePeImports(pe).imports).toEqual([]);
  });

  it("rejects a buffer that is not a PE image", () => {
    const notPe = Buffer.alloc(0x400, 0x41);
    expect(() => parsePeImports(notPe)).toThrow(/MZ signature/);

    const hijacked = buildPe({ importSpecs: [{ dll: "libfoo-1.dll", functions: [{ name: "f1" }] }] });
    hijacked.write("XY\0\0", 0x80, "ascii");
    expect(() => parsePeImports(hijacked)).toThrow(/PE signature/);
  });

  it("rejects a payload truncated before the import data", () => {
    const pe = buildPe({ importSpecs: [{ dll: "libfoo-1.dll", functions: [{ name: "f1" }] }] });
    const truncated = pe.subarray(0, 0x3f0);
    expect(() => parsePeImports(truncated)).toThrow(PeParseError);
    expect(() => parsePeImports(truncated)).toThrow(/import/);
  });
});

describe("peMachineName", () => {
  it("maps the machines that appear in staged sidecars", () => {
    expect(peMachineName(0x8664)).toBe("x86_64");
    expect(peMachineName(0xaa64)).toBe("aarch64");
    expect(peMachineName(0x14c)).toBe("0x14c");
  });
});
