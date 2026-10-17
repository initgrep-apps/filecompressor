// @vitest-environment node
import { describe, expect, it } from "vitest";
import { PeParseError, parsePeImports, peMachineName } from "./pe-imports.mjs";

const SECTION_VADDR = 0x1000;
const SECTION_RAW_PTR = 0x400;
const SECTION_SIZE = 0x1000;
const DOS_SIZE = 0x80;
const DESCRIPTOR_SIZE = 20;
const IMPORT_DIR_INDEX = 1;

function sectionOffset(rva) {
  return SECTION_RAW_PTR + (rva - SECTION_VADDR);
}

function optionalStandardBytes(magic) {
  return magic === 0x20b ? 112 : 96;
}

function thunkSizeFor(magic) {
  return magic === 0x20b ? 8 : 4;
}

function buildPe({
  machine = 0x8664,
  magic = 0x20b,
  importSpecs = [],
} = {}) {
  const standard = optionalStandardBytes(magic);
  const optionalTotal = standard + 16 * 8;
  const sectionsOffset = 0x98 + optionalTotal;
  const buffer = Buffer.alloc(SECTION_RAW_PTR + SECTION_SIZE);
  buffer.write("MZ", 0, "ascii");
  buffer.writeUInt32LE(DOS_SIZE, 0x3c);
  buffer.write("PE\0\0", 0x80, "ascii");
  buffer.writeUInt16LE(machine, 0x84);
  buffer.writeUInt16LE(1, 0x86);
  buffer.writeUInt16LE(optionalTotal, 0x94);
  buffer.writeUInt16LE(magic, 0x98);
  buffer.writeUInt32LE(16, 0x98 + standard - 4);

  buffer.write("DEEP\0\0\0\0", sectionsOffset, "ascii");
  buffer.writeUInt32LE(SECTION_SIZE, sectionsOffset + 8);
  buffer.writeUInt32LE(SECTION_VADDR, sectionsOffset + 12);
  buffer.writeUInt32LE(SECTION_SIZE, sectionsOffset + 16);
  buffer.writeUInt32LE(SECTION_RAW_PTR, sectionsOffset + 20);

  let cursor = SECTION_VADDR;
  const descriptorBase = cursor;
  cursor += DESCRIPTOR_SIZE * (importSpecs.length + 1);
  buffer.writeUInt32LE(descriptorBase, 0x98 + standard + IMPORT_DIR_INDEX * 8);
  buffer.writeUInt32LE(DESCRIPTOR_SIZE * (importSpecs.length + 1), 0x98 + standard + IMPORT_DIR_INDEX * 8 + 4);

  const thunkRvas = [];
  for (const spec of importSpecs) {
    thunkRvas.push(cursor);
    cursor += thunkSizeFor(magic) * (spec.functions.length + 1);
  }
  const ordinalFlag = magic === 0x20b ? 0x8000000000000000n : 0x80000000n;
  importSpecs.forEach((spec, index) => {
    const at = sectionOffset(thunkRvas[index]);
    spec.functions.forEach((fn, slot) => {
      if (fn === null) {
        if (magic === 0x20b) {
          buffer.writeBigUInt64LE(ordinalFlag, at + slot * 8);
        } else {
          buffer.writeUInt32LE(0x80000000, at + slot * 4);
        }
        return;
      }
      const hintRva = cursor;
      cursor += 2 + fn.name.length + 1;
      buffer.writeUInt16LE(0x7f, sectionOffset(hintRva));
      buffer.write(`${fn.name}\0`, sectionOffset(hintRva) + 2, "ascii");
      if (magic === 0x20b) {
        buffer.writeUInt32LE(hintRva, at + slot * 8);
      } else {
        buffer.writeUInt32LE(hintRva, at + slot * 4);
      }
    });
  });

  const dllNameRvas = [];
  for (const spec of importSpecs) {
    dllNameRvas.push(cursor);
    const name = Buffer.from(`${spec.dll}\0`, "ascii");
    name.copy(buffer, sectionOffset(cursor));
    cursor += name.length;
  }

  importSpecs.forEach((spec, index) => {
    const at = sectionOffset(descriptorBase + index * DESCRIPTOR_SIZE);
    buffer.writeUInt32LE(thunkRvas[index], at);
    buffer.writeUInt32LE(dllNameRvas[index], at + 12);
    buffer.writeUInt32LE(thunkRvas[index], at + 16);
  });

  return buffer;
}

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
    const truncated = pe.subarray(0, SECTION_RAW_PTR - 16);
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
