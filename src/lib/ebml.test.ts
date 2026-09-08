/**
 * The EBML primitives, against bytes written out by hand.
 *
 * Every fixture here is a literal byte array rather than a fragment of a real file, because
 * the things that break a tag-length-value reader are the ones a real file never contains: a
 * truncated header, an unknown length, a four-byte id whose top bit would go negative under
 * `<<`, a size too large to be an exact number.
 */

import { describe, expect, test } from "bun:test";
import { childrenOf, elementsIn, elementUint, findChild, readElement, readUint, vintLength } from "./ebml";

const bytes = (...b: number[]) => new Uint8Array(b);

describe("VINT lengths", () => {
  test("the first set bit says how many bytes the field occupies", () => {
    expect(vintLength(0x82)).toBe(1);
    expect(vintLength(0x40)).toBe(2);
    expect(vintLength(0x1a)).toBe(4);
    expect(vintLength(0x01)).toBe(8);
  });

  /** A byte with no set bit describes a VINT longer than eight bytes: padding, or a bad offset. */
  test("a zero byte begins no VINT at all", () => {
    expect(vintLength(0x00)).toBe(0);
  });
});

describe("big-endian unsigned integers", () => {
  test("a four-byte value stays positive, which a shift would not", () => {
    // 0x9FDFA3B4 has its top bit set; `<<` would report this as negative.
    expect(readUint(bytes(0x9f, 0xdf, 0xa3, 0xb4), 0, 4)).toBe(0x9fdfa3b4);
  });

  test("a zero-length value is zero, which is how EBML writes a default", () => {
    expect(readUint(bytes(0x01), 0, 0)).toBe(0);
  });

  test("reading past the end is null rather than a short answer", () => {
    expect(readUint(bytes(0x01, 0x02), 0, 4)).toBeNull();
  });

  /** A rounded file offset is a seek to the wrong place, so an inexact answer is no answer. */
  test("a value too large to be exact is null rather than approximate", () => {
    expect(readUint(bytes(0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), 0, 8)).toBeNull();
  });
});

describe("element headers", () => {
  test("a one-byte id with a one-byte size", () => {
    // 0xB3 (CueTime), size 2, data 0x01F4.
    expect(readElement(bytes(0xb3, 0x82, 0x01, 0xf4), 0)).toEqual({
      id: 0xb3,
      start: 0,
      dataStart: 2,
      dataSize: 2,
    });
  });

  test("a four-byte id keeps its length marker, as every spec and SeekID writes it", () => {
    const el = readElement(bytes(0x1a, 0x45, 0xdf, 0xa3, 0x84, 1, 2, 3, 4), 0);
    expect(el?.id).toBe(0x1a45dfa3);
    expect(el?.dataStart).toBe(5);
    expect(el?.dataSize).toBe(4);
  });

  /** A live stream writes a Segment whose length it does not know yet. */
  test("an all-ones size is unknown rather than a huge number", () => {
    expect(readElement(bytes(0xb3, 0xff), 0)?.dataSize).toBeNull();
  });

  /**
   * REGRESSION, measured on two 15 GB films from this library on 2026-09-08. Matroska writes
   * the Segment's own size as an eight-byte all-ones "unknown", so a reader that decodes the
   * size by subtracting the marker overflows the exact-integer range on the FIRST size field
   * of a real file and reports that there is no Segment at all.
   */
  test("a Segment of unknown length still parses, which is how real files begin", () => {
    const segment = bytes(0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff);
    expect(readElement(segment, 0)).toEqual({
      id: 0x18538067,
      start: 0,
      dataStart: 12,
      dataSize: null,
    });
  });

  test("a size padded out to eight bytes is read as the small number it is", () => {
    const padded = bytes(0xb3, 0x01, 0, 0, 0, 0, 0, 0, 0x04, 1, 2, 3, 4);
    expect(readElement(padded, 0)?.dataSize).toBe(4);
  });

  test("a header that runs off the end of the buffer is null", () => {
    expect(readElement(bytes(0x1a, 0x45), 0)).toBeNull();
    expect(readElement(bytes(0xb3), 0)).toBeNull();
  });

  test("a byte that begins no VINT is null rather than an invented element", () => {
    expect(readElement(bytes(0x00, 0x00, 0x00), 0)).toBeNull();
  });
});

describe("walking a run of elements", () => {
  const run = bytes(0xb3, 0x81, 0x07, 0xf7, 0x81, 0x01, 0xb3, 0x81, 0x09);

  test("every element in the range, in file order", () => {
    expect([...elementsIn(run, 0, run.length)].map((e) => e.id)).toEqual([0xb3, 0xf7, 0xb3]);
  });

  test("it stops at the first thing it cannot make sense of rather than throwing", () => {
    const garbled = bytes(0xb3, 0x81, 0x07, 0x00, 0x00, 0x00);
    expect([...elementsIn(garbled, 0, garbled.length)]).toHaveLength(1);
  });

  /** There is no way past an element of unknown size without understanding its contents. */
  test("it stops after an element of unknown size", () => {
    const unknown = bytes(0xb3, 0xff, 0xf7, 0x81, 0x01);
    expect([...elementsIn(unknown, 0, unknown.length)]).toHaveLength(1);
  });

  test("children are clamped to what was actually read", () => {
    // A master element declaring 40 bytes of children when only three are present.
    const master = bytes(0xbb, 0xa8, 0xb3, 0x81, 0x07);
    const el = readElement(master, 0);
    expect(el).not.toBeNull();
    expect([...childrenOf(master, el as NonNullable<typeof el>)].map((c) => c.id)).toEqual([0xb3]);
  });

  test("a named child, and its value", () => {
    const master = bytes(0xbb, 0x86, 0xb3, 0x81, 0x07, 0xf7, 0x81, 0x02);
    const el = readElement(master, 0) as NonNullable<ReturnType<typeof readElement>>;
    const track = findChild(master, el, 0xf7);
    expect(track).not.toBeNull();
    expect(elementUint(master, track as NonNullable<typeof track>)).toBe(2);
    expect(findChild(master, el, 0x4444)).toBeNull();
  });
});
