/**
 * The three primitives Matroska is written in: an element id, a data size, and a big-endian
 * integer. Bytes in, numbers out -- no filesystem, no clock, nothing container-specific.
 *
 * EBML is a tag-length-value format. Both the tag and the length are VINTs: the first byte's
 * leading zeroes say how many bytes the field occupies, and the first set bit is the marker.
 * The two differ in exactly one way, and it is the way that trips people up:
 *
 * - **An ELEMENT ID keeps its marker.** `0x1A45DFA3` is the EBML header's id including the
 *   length descriptor, and that is the form every specification, every hex dump and every
 *   `SeekID` payload writes it in. Stripping it would make our constants disagree with the
 *   file and with the spec at once.
 * - **A DATA SIZE strips its marker**, because it is a number rather than a name. A size
 *   whose value bits are ALL SET means "unknown", which is how a live stream writes a Segment
 *   whose length it does not know yet -- and which is why `dataSize` is nullable here rather
 *   than a sentinel a caller could accidentally do arithmetic on.
 *
 * `matroska-cues.ts` is the only consumer today. This is separate from it because the two have
 * different reasons to change: this file changes if EBML does (it will not), and that one
 * changes as we learn more about how real files lay their index out.
 */

/** The most bytes an element id may occupy. Matroska never publishes a longer one. */
const MAX_ID_BYTES = 4;

/** The most bytes a VINT may occupy at all, id or size. */
const MAX_VINT_BYTES = 8;

/** One element's header, resolved. Offsets are in the coordinates of the buffer handed in. */
export interface EbmlElement {
  /** The id WITH its length marker, as the spec and every `SeekID` payload write it. */
  id: number;
  /** Where the header starts -- what a `SeekPosition` points at. */
  start: number;
  /** Where the data starts, i.e. just past the header. */
  dataStart: number;
  /** How many data bytes, or null when the element declares an unknown size. */
  dataSize: number | null;
}

/**
 * How many bytes the VINT beginning with this byte occupies, or 0 when it begins none.
 *
 * A leading byte of 0x00 would describe a VINT longer than eight bytes, which no Matroska
 * writer emits and which this refuses rather than guessing at -- in practice a zero byte here
 * means we are reading padding or the wrong offset, and continuing would invent elements.
 */
export function vintLength(first: number): number {
  for (let n = 1; n <= MAX_VINT_BYTES; n++) {
    if (first & (0x80 >> (n - 1))) return n;
  }
  return 0;
}

/**
 * A big-endian unsigned integer, the only numeric encoding this reader needs.
 *
 * Accumulated by multiplication rather than with `<<`, because JavaScript's bitwise operators
 * work on SIGNED 32-bit values: a four-byte id like `0x9FDFA3B4` would come back negative and
 * silently stop matching its own constant. Anything that will not survive as an exact double
 * is null rather than an approximation -- a rounded file offset is a seek to the wrong place.
 */
export function readUint(buf: Uint8Array, start: number, length: number): number | null {
  if (start < 0 || length < 0 || length > MAX_VINT_BYTES || start + length > buf.length) return null;
  let value = 0;
  for (let i = 0; i < length; i++) value = value * 256 + (buf[start + i] as number);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * The element header at `pos`, or null when the buffer does not hold a whole valid one.
 *
 * Null covers three different disappointments on purpose -- a truncated buffer, a byte that
 * begins no VINT, and a size too large to be an exact number -- because a caller has the same
 * move for all three: stop reading here and fall back to the path that does not need this.
 */
export function readElement(buf: Uint8Array, pos: number): EbmlElement | null {
  const idFirst = buf[pos];
  if (idFirst === undefined) return null;
  const idLength = vintLength(idFirst);
  if (idLength === 0 || idLength > MAX_ID_BYTES) return null;
  const id = readUint(buf, pos, idLength);
  if (id === null) return null;

  const sizeAt = pos + idLength;
  const sizeFirst = buf[sizeAt];
  if (sizeFirst === undefined) return null;
  const sizeLength = vintLength(sizeFirst);
  if (sizeLength === 0) return null;
  const dataStart = sizeAt + sizeLength;
  if (dataStart > buf.length) return null;

  return { id, start: pos, dataStart, dataSize: readSizeValue(buf, sizeAt, sizeLength) };
}

/**
 * The value of a data-size field: the marker stripped, then the bytes accumulated.
 *
 * > [!CAUTION] STRIP THE MARKER FIRST, NEVER SUBTRACT IT AFTERWARDS
 * > An eight-byte size field carries its marker at bit 56, so reading the field as one number
 * > and subtracting `2**56` overflows the exact-integer range on the way -- and the first
 * > thing that costs is not an exotic file. **Matroska writes the Segment's own size as an
 * > eight-byte all-ones "unknown"**, which is the very first size field in most real files;
 * > measured against two 15 GB films off this library on 2026-09-08, and both of them made a
 * > subtract-afterwards reader return null for the Segment and see no Matroska at all.
 */
function readSizeValue(buf: Uint8Array, at: number, length: number): number | null {
  const valueBits = 0xff >> length;
  let value = (buf[at] as number) & valueBits;
  let allOnes = value === valueBits;
  for (let i = 1; i < length; i++) {
    const byte = buf[at + i] as number;
    allOnes = allOnes && byte === 0xff;
    value = value * 256 + byte;
  }
  // All value bits set is the reserved "unknown length" pattern, and an inexact size is one
  // this reader will not seek by -- both are null, and a caller stops reading at either.
  return allOnes || !Number.isSafeInteger(value) ? null : value;
}

/**
 * Every element laid out in `[start, end)`, in file order.
 *
 * Stops rather than throws at the first thing it cannot make sense of, and stops after an
 * element of unknown size -- there is no way past one without understanding what is inside it,
 * and this reader deliberately understands nothing.
 *
 * An element whose DATA runs past `end` is still yielded: for navigation, knowing where a Cues
 * element begins is the useful half, and reading it is a separate seek anyway.
 */
export function* elementsIn(buf: Uint8Array, start: number, end: number): Generator<EbmlElement> {
  let pos = start;
  while (pos < end) {
    const el = readElement(buf, pos);
    if (!el || el.dataStart > end) return;
    yield el;
    if (el.dataSize === null) return;
    pos = el.dataStart + el.dataSize;
  }
}

/**
 * The children of one element, when its data is present in this same buffer.
 *
 * Clamped to the buffer, so a master element whose declared size runs past what was read
 * yields the children that are actually there instead of reading off the end.
 */
export function childrenOf(buf: Uint8Array, el: EbmlElement): Generator<EbmlElement> {
  const declaredEnd = el.dataSize === null ? buf.length : el.dataStart + el.dataSize;
  return elementsIn(buf, el.dataStart, Math.min(declaredEnd, buf.length));
}

/** The first child with this id, or null. */
export function findChild(buf: Uint8Array, el: EbmlElement, id: number): EbmlElement | null {
  for (const child of childrenOf(buf, el)) {
    if (child.id === id) return child;
  }
  return null;
}

/** The unsigned integer value of an element's data, or null when it does not hold one. */
export function elementUint(buf: Uint8Array, el: EbmlElement): number | null {
  if (el.dataSize === null) return null;
  return readUint(buf, el.dataStart, el.dataSize);
}
