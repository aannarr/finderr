/**
 * Picking a video encoder, for every platform, from one machine.
 *
 * `chooseEncoder` is pure precisely so the Synology's answer and the Mac's answer are both
 * testable here. The rule every case circles: **an unproven encoder falls to software**,
 * because software is slow and always right where a wrong hardware guess is a spawn error
 * and a title that will not play at all.
 */

import { describe, expect, test } from "bun:test";
import { chooseEncoder, parseEncoders, probeEncoder, SOFTWARE, VAAPI_DEVICE } from "./encoder";

/** Verbatim shape of `ffmpeg -encoders`, including the header it prints first. */
const ENCODERS_MACOS = `Encoders:
 V..... = Video
 ------
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)
 V....D hevc_videotoolbox    VideoToolbox H.265 Encoder (codec hevc)
 A....D aac                  AAC (Advanced Audio Coding)
`;

const ENCODERS_LINUX_VAAPI = `Encoders:
 ------
 V....D libx264              libx264 H.264 / AVC
 V....D h264_vaapi           H.264/AVC (VAAPI) (codec h264)
`;

describe("parseEncoders reads what ffmpeg actually prints", () => {
  test("pulls names out and ignores the header", () => {
    const names = parseEncoders(ENCODERS_MACOS);
    expect(names).toContain("h264_videotoolbox");
    expect(names).toContain("libx264");
    expect(names).toContain("aac");
    expect(names).not.toContain("Encoders:");
  });

  test("empty output yields no names rather than throwing", () => {
    expect(parseEncoders("")).toEqual([]);
    expect(parseEncoders("ffmpeg: command not found")).toEqual([]);
  });
});

describe("chooseEncoder picks the best PROVEN option", () => {
  test("macOS gets VideoToolbox, with no device node to check", () => {
    const c = chooseEncoder({ platform: "darwin", available: parseEncoders(ENCODERS_MACOS), hasDri: false });
    expect(c.encoder).toBe("h264_videotoolbox");
    expect(c.hardware).toBe(true);
    expect(c.hwaccel).toBe("videotoolbox");
    expect(c.vaapiDevice).toBeNull();
  });

  test("Linux with a render node gets VAAPI, and it names the node", () => {
    const c = chooseEncoder({
      platform: "linux",
      available: parseEncoders(ENCODERS_LINUX_VAAPI),
      hasDri: true,
    });
    expect(c.encoder).toBe("h264_vaapi");
    expect(c.vaapiDevice).toBe(VAAPI_DEVICE);
  });

  /**
   * QSV is Intel's own path and generally better at the same bitrate, but its runtime is
   * frequently missing from a container -- so it wins when present and VAAPI stays behind
   * it rather than being replaced by it.
   */
  test("QSV beats VAAPI when both are compiled in", () => {
    const c = chooseEncoder({
      platform: "linux",
      available: ["libx264", "h264_vaapi", "h264_qsv"],
      hasDri: true,
    });
    expect(c.encoder).toBe("h264_qsv");
  });

  /**
   * BEING LISTED IS NOT BEING USABLE. A build with VAAPI compiled in and no `/dev/dri`
   * fails at spawn, which is a title that will not play rather than a slow one.
   */
  test("VAAPI without a render node falls to software", () => {
    const c = chooseEncoder({ platform: "linux", available: ["libx264", "h264_vaapi"], hasDri: false });
    expect(c).toEqual(SOFTWARE);
  });

  test("a Linux build with no hardware encoder at all falls to software", () => {
    const c = chooseEncoder({ platform: "linux", available: ["libx264"], hasDri: true });
    expect(c).toEqual(SOFTWARE);
  });

  /** VideoToolbox is macOS-only; the name appearing on Linux would be a build oddity. */
  test("VideoToolbox is not chosen off macOS", () => {
    const c = chooseEncoder({
      platform: "linux",
      available: ["libx264", "h264_videotoolbox"],
      hasDri: false,
    });
    expect(c).toEqual(SOFTWARE);
  });

  /** NVENC needs no render node -- `/dev/dri` is an Intel/AMD thing. */
  test("NVENC is chosen without a render node", () => {
    const c = chooseEncoder({ platform: "linux", available: ["libx264", "h264_nvenc"], hasDri: false });
    expect(c.encoder).toBe("h264_nvenc");
  });

  test("an unknown platform falls to software", () => {
    const c = chooseEncoder({ platform: "freebsd", available: ["libx264", "h264_vaapi"], hasDri: true });
    expect(c).toEqual(SOFTWARE);
  });

  test("every choice explains itself, because the boot log prints it", () => {
    for (const env of [
      { platform: "darwin", available: parseEncoders(ENCODERS_MACOS), hasDri: false },
      { platform: "linux", available: ["h264_vaapi"], hasDri: true },
      { platform: "linux", available: ["libx264"], hasDri: false },
    ]) {
      expect(chooseEncoder(env).reason.length).toBeGreaterThan(0);
    }
  });
});

describe("probeEncoder", () => {
  test("asks ffmpeg once and maps the answer", async () => {
    const calls: string[][] = [];
    const c = await probeEncoder({
      platform: "darwin",
      hasDri: false,
      run: async (argv) => {
        calls.push(argv);
        return { ok: true, stdout: ENCODERS_MACOS, stderr: "" };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("-encoders");
    expect(c.encoder).toBe("h264_videotoolbox");
  });

  /** No ffmpeg is not a crash: playback fails later with a message about the file. */
  test("a missing ffmpeg yields software rather than throwing", async () => {
    const c = await probeEncoder({
      platform: "linux",
      hasDri: true,
      run: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(c).toEqual(SOFTWARE);
  });

  test("reads help printed to stderr as well as stdout", async () => {
    const c = await probeEncoder({
      platform: "darwin",
      hasDri: false,
      run: async () => ({ ok: true, stdout: "", stderr: ENCODERS_MACOS }),
    });
    expect(c.encoder).toBe("h264_videotoolbox");
  });
});
