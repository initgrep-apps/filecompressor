export const IMPORT_DIR_INDEX = 1;
const SECTION_VADDR = 0x1000;
const SECTION_RAW_PTR = 0x400;
const SECTION_SIZE = 0x1000;
const DOS_SIZE = 0x80;
const DESCRIPTOR_SIZE = 20;

function sectionOffset(rva) {
  return SECTION_RAW_PTR + (rva - SECTION_VADDR);
}

function optionalStandardBytes(magic) {
  return magic === 0x20b ? 112 : 96;
}

function thunkSizeFor(magic) {
  return magic === 0x20b ? 8 : 4;
}

export function buildPe({
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
