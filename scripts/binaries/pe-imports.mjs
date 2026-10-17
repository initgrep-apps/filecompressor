const DOS_MAGIC = 0x5a4d;
const PE_SIGNATURE = 0x00004550;
const IMPORT_DIR_INDEX = 1;
const ORDINAL32_FLAG = 0x80000000;
const ORDINAL64_FLAG = 0x8000000000000000n;

export class PeParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "PeParseError";
  }
}

const MACHINE_NAMES = {
  0x6664: "x86_64",
  0x8664: "x86_64",
  0xaa64: "aarch64",
  0x1c0: "arm",
  0x1c4: "arm",
};

export function peMachineName(machine) {
  return MACHINE_NAMES[machine] ?? `0x${machine.toString(16)}`;
}

class Reader {
  constructor(view) {
    this.view = view;
  }

  at(offset, length, what) {
    if (offset < 0 || offset + length > this.view.length) {
      throw new PeParseError(
        `${what} lies outside the buffer (image truncated): offset 0x${offset.toString(16)} for ${length} bytes, image holds ${this.view.length}`,
      );
    }
    return offset;
  }

  u16(offset, what) {
    return this.view.readUInt16LE(this.at(offset, 2, what));
  }

  u32(offset, what) {
    return this.view.readUInt32LE(this.at(offset, 4, what));
  }

  bytes(offset, length, what) {
    const last = Math.max(length, 1);
    return this.view.subarray(this.at(offset, last, what), offset + length);
  }

  cString(offset, what) {
    this.at(offset, 1, what);
    let end = offset;
    while (end < this.view.length && this.view[end] !== 0) {
      end += 1;
    }
    if (end === this.view.length) {
      throw new PeParseError(`${what} is unterminated: no NUL before the end of the image`);
    }
    return this.view.toString("ascii", offset, end);
  }
}

export function parsePeImports(buffer) {
  const view = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer.buffer ?? buffer);
  const reader = new Reader(view);
  if (view.length < 0x40) {
    throw new PeParseError(`not a PE image: ${view.length} bytes are smaller than the DOS header`);
  }
  if (view.readUInt16LE(0) !== DOS_MAGIC) {
    throw new PeParseError("not a PE image: MZ signature missing");
  }
  const eLfanew = reader.u32(0x3c, "e_lfanew");
  reader.at(eLfanew, 4, "PE signature");
  if (view.readUInt32LE(eLfanew) !== PE_SIGNATURE) {
    throw new PeParseError("not a PE image: PE signature missing just past e_lfanew");
  }
  const machine = reader.u16(eLfanew + 4, "COFF machine");
  const sectionCount = reader.u16(eLfanew + 6, "COFF section count");
  const optionalSize = reader.u16(eLfanew + 20, "COFF size of optional header");
  const optionalAt = eLfanew + 24;
  reader.at(optionalAt, optionalSize, "optional header");
  const magic = reader.u16(optionalAt, "optional header magic");
  if (magic !== 0x10b && magic !== 0x20b) {
    throw new PeParseError(
      `unsupported optional-header magic 0x${magic.toString(16)} (expected 0x10b or 0x20b)`,
    );
  }
  const standardBytes = magic === 0x20b ? 112 : 96;
  const dirCount = reader.u32(standardBytes - 4 + optionalAt, "NumberOfRvaAndSizes");
  if (dirCount <= IMPORT_DIR_INDEX) {
    return { machine, imports: [] };
  }
  const importRva = reader.u32(optionalAt + standardBytes + IMPORT_DIR_INDEX * 8, "import directory rva");
  const importSize = reader.u32(optionalAt + standardBytes + IMPORT_DIR_INDEX * 8 + 4, "import directory size");
  if (importRva === 0 || importSize === 0) {
    return { machine, imports: [] };
  }

  const sectionsAt = optionalAt + optionalSize;
  const sections = [];
  for (let i = 0; i < sectionCount; i += 1) {
    const headerAt = sectionsAt + i * 40;
    sections.push({
      virtualSize: reader.u32(headerAt + 8, `section ${i} virtual size`),
      virtualAddress: reader.u32(headerAt + 12, `section ${i} virtual address`),
      rawSize: reader.u32(headerAt + 16, `section ${i} raw size`),
      rawPointer: reader.u32(headerAt + 20, `section ${i} raw pointer`),
    });
  }

  const fileOffsetFor = (rva, what) => {
    const section = sections.find(
      (entry) =>
        rva >= entry.virtualAddress &&
        rva < entry.virtualAddress + Math.max(entry.virtualSize, entry.rawSize),
    );
    if (!section) {
      throw new PeParseError(`import ${what} rva 0x${rva.toString(16)} is not covered by any section`);
    }
    const offset = section.rawPointer + (rva - section.virtualAddress);
    reader.at(offset, 1, `import ${what}`);
    return offset;
  };

  const imports = [];
  let descriptorAt = fileOffsetFor(importRva, "descriptor");
  const descriptorBudget = 20 * (1 + Math.floor(importSize / 20));
  const descriptorEnd = descriptorAt + Math.max(descriptorBudget, 20);
  while (descriptorAt < descriptorEnd) {
    reader.at(descriptorAt, 20, "import descriptor");
    const originalFirstThunk = view.readUInt32LE(descriptorAt);
    const nameRva = view.readUInt32LE(descriptorAt + 12);
    const firstThunk = view.readUInt32LE(descriptorAt + 16);
    if ((originalFirstThunk | nameRva | firstThunk) === 0) {
      break;
    }
    const dll = reader.cString(fileOffsetFor(nameRva, "dll name"), "import dll name");
    let ordinalOnly = true;
    let thunkAt = fileOffsetFor(
      originalFirstThunk !== 0 ? originalFirstThunk : firstThunk,
      "thunk array",
    );
    for (let guard = 0; guard < 65536; guard += 1) {
      if (magic === 0x20b) {
        const entry = view.readBigUInt64LE(thunkAt);
        thunkAt += 8;
        if (entry === 0n) break;
        if (!(entry & ORDINAL64_FLAG)) ordinalOnly = false;
      } else {
        const entry = view.readUInt32LE(thunkAt);
        thunkAt += 4;
        if (entry === 0) break;
        if (!(entry & ORDINAL32_FLAG)) ordinalOnly = false;
      }
    }
    imports.push({ dll, ordinalOnly });
    descriptorAt += 20;
  }
  return { machine, imports };
}
