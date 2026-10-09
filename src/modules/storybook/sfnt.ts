/**
 * TrueType surgery that makes `@pdf-lib/fontkit`'s subsetter produce a correct
 * font. Without it, roughly half the Chinese characters in an exported book
 * come out **blank** — nothing throws, nothing logs, and the PDF's text layer
 * stays perfect, so the failure is invisible until someone looks at a page.
 *
 * ## The bug
 *
 * When pdf-lib embeds a subset (`embedFont(bytes, { subset: true })`) the glyph
 * data is written by fontkit's `TTFSubset`. On the way out, fontkit's `loca`
 * table encoder does this (`fontkit.umd.js`, `loca.preEncode`):
 *
 * ```js
 * this.version = this.offsets[this.offsets.length - 1] > 0xffff ? 1 : 0;
 * if (this.version === 0) {
 *   for (let i = 0; i < this.offsets.length; i++) this.offsets[i] >>>= 1;
 * }
 * ```
 *
 * Version 0 is the *short* `loca` format, which stores each offset halved in a
 * `uint16`. Halving is only lossless when the offset is even — and nothing in
 * the encoder aligns glyph records to even lengths, so about half of them land
 * on odd offsets and are written back one byte early. A reader (fontkit's own
 * `loca.process` doubles them again, and so does every PDF viewer) then slices
 * the glyph data one byte out of place, which decodes to an empty or corrupt
 * glyph: the character simply does not draw.
 *
 * A subset of a Latin font hit this too, but a glyph there is a few dozen bytes
 * and a shifted read usually still decodes to *something*; CJK glyphs are large
 * and fail outright. Measured on one 4-page Chinese book: 38 of the 84 glyphs
 * in the subset had no outline at all.
 *
 * ## The workaround
 *
 * Pad every glyph record in the *source* font to an even length. Every offset
 * in any subset of that font is then a sum of even lengths — even — so the
 * halving is exact and the subset comes out byte-for-byte right. Padding a
 * glyph record is a legal font edit: a reader consumes exactly the bytes the
 * record declares (contours, instructions, flags, coordinates) and ignores
 * whatever follows, so trailing zeros are inert.
 *
 * This costs one pass over a ~10 MB font per process (the result is memoized by
 * the caller) and ~5% more glyph bytes in the subset.
 */

/** sfnt offset fields are relative to the start of the file, not the table. */
const SFNT_HEADER = 12;

interface TableRecord {
  tag: string;
  offset: number;
  length: number;
}

function readTag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset],
    bytes[offset + 1],
    bytes[offset + 2],
    bytes[offset + 3]
  );
}

/** Sum of the data as big-endian uint32 words, final word zero-padded. */
function checksum(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const word =
      ((data[i] ?? 0) << 24) |
      ((data[i + 1] ?? 0) << 16) |
      ((data[i + 2] ?? 0) << 8) |
      (data[i + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum;
}

const align4 = (n: number) => (n + 3) & ~3;

/**
 * Rewrite `font` so every glyph record starts and ends on an even offset.
 *
 * Returns the input unchanged when there is nothing to do: a CFF (`OTTO`) font
 * has no `glyf` table, and a font whose records are already even is left alone.
 */
export function padGlyphRecordsEvenly(font: Uint8Array): Uint8Array {
  if (font.length < SFNT_HEADER) return font;
  const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
  const numTables = view.getUint16(4);

  const records: TableRecord[] = [];
  for (let i = 0; i < numTables; i++) {
    const record = 12 + i * 16;
    records.push({
      tag: readTag(font, record),
      offset: view.getUint32(record + 8),
      length: view.getUint32(record + 12),
    });
  }
  const find = (tag: string) => records.find((t) => t.tag === tag);

  const glyf = find('glyf');
  const loca = find('loca');
  const head = find('head');
  const maxp = find('maxp');
  // No glyf table means a CFF font, which fontkit subsets through a different
  // path; there is no loca to corrupt.
  if (!glyf || !loca || !head || !maxp) return font;

  const numGlyphs = view.getUint16(maxp.offset + 4);
  const longLoca = view.getInt16(head.offset + 50) === 1;

  const offsets = new Array<number>(numGlyphs + 1);
  for (let i = 0; i <= numGlyphs; i++) {
    offsets[i] = longLoca
      ? view.getUint32(loca.offset + i * 4)
      : view.getUint16(loca.offset + i * 2) * 2;
  }
  if (offsets.every((offset) => offset % 2 === 0)) return font;

  // --- Rebuild glyf with even-length records, and loca to match -------------
  let total = 0;
  for (let i = 0; i < numGlyphs; i++) {
    total += offsets[i + 1] - offsets[i];
    if ((offsets[i + 1] - offsets[i]) % 2 === 1) total += 1;
  }
  const newGlyf = new Uint8Array(total);
  // Long format unconditionally: a 30k-glyph font needs it anyway, and it makes
  // the parity question moot for anyone reading this table.
  const newLoca = new Uint8Array((numGlyphs + 1) * 4);
  const newLocaView = new DataView(newLoca.buffer);
  let cursor = 0;
  for (let i = 0; i < numGlyphs; i++) {
    newLocaView.setUint32(i * 4, cursor);
    const length = offsets[i + 1] - offsets[i];
    newGlyf.set(
      font.subarray(
        glyf.offset + offsets[i],
        glyf.offset + offsets[i] + length
      ),
      cursor
    );
    cursor += length % 2 === 1 ? length + 1 : length;
  }
  newLocaView.setUint32(numGlyphs * 4, cursor);

  const newHead = font.slice(head.offset, head.offset + head.length);
  const newHeadView = new DataView(
    newHead.buffer,
    newHead.byteOffset,
    newHead.byteLength
  );
  newHeadView.setInt16(50, 1); // indexToLocFormat: long
  newHeadView.setUint32(8, 0); // checkSumAdjustment, written last

  // --- Reassemble the sfnt -------------------------------------------------
  const tables = records
    .map((record) => ({
      tag: record.tag,
      data:
        record.tag === 'glyf'
          ? newGlyf
          : record.tag === 'loca'
            ? newLoca
            : record.tag === 'head'
              ? newHead
              : font.slice(record.offset, record.offset + record.length),
    }))
    // The directory is specified to be sorted by tag; readers are allowed to
    // binary-search it even when, as in this source font, it is not.
    .sort((a, b) => a.tag.localeCompare(b.tag));

  const directorySize = records.length * 16;
  const tablesSize = tables.reduce((sum, t) => sum + align4(t.data.length), 0);
  const out = new Uint8Array(align4(SFNT_HEADER + directorySize + tablesSize));
  const outView = new DataView(out.buffer);
  outView.setUint32(0, view.getUint32(0)); // sfntVersion
  outView.setUint16(4, numTables);
  const entrySelector = Math.floor(Math.log2(numTables));
  const searchRange = 16 * 2 ** entrySelector;
  outView.setUint16(6, searchRange);
  outView.setUint16(8, entrySelector);
  outView.setUint16(10, numTables * 16 - searchRange);

  let offset = SFNT_HEADER + directorySize;
  const headRecord =
    SFNT_HEADER + tables.findIndex((t) => t.tag === 'head') * 16;
  for (const [index, table] of tables.entries()) {
    out.set(table.data, offset);
    const record = SFNT_HEADER + index * 16;
    for (let i = 0; i < 4; i++) out[record + i] = table.tag.charCodeAt(i);
    outView.setUint32(record + 4, checksum(table.data));
    outView.setUint32(record + 8, offset);
    outView.setUint32(record + 12, table.data.length);
    offset = align4(offset + table.data.length);
  }

  // head's checkSumAdjustment makes the whole file sum to 0xB1B0AFBA. This is
  // deliberately the last write: head's directory checksum above is the one
  // taken with the adjustment zeroed (which is how the spec defines it, and
  // why a real font's head entry looks "off" by exactly this value), and
  // re-checksumming head afterwards would break the whole-file invariant.
  const headOffset = outView.getUint32(headRecord + 8);
  outView.setUint32(headOffset + 8, (0xb1b0afba - checksum(out)) >>> 0);

  return out;
}
