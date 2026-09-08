/**
 * Picking a video encoder, for every platform, from one machine.
 *
 * `chooseEncoder` is pure precisely so the Synology's answer and the Mac's answer are both
 * testable here. The rule every case circles: **an unproven encoder falls to software**,
 * because software is slow and always right where a wrong hardware guess is a spawn error
 * and a title that will not play at all.
 */

import { describe, expect, test } from "bun:test";
import {
  chooseEncoder,
  type EncoderEnvironment,
  parseEncoders,
  probeEncoder,
  probeQsvRuntime,
  SOFTWARE,
  VAAPI_DEVICE,
} from "./encoder";

/**
 * An environment with NO hardware evidence, so each case states only the evidence it means.
 *
 * Spelling `hasDri: false, hasQsvRuntime: false` into a dozen literals would bury the one
 * field each test is actually about, which is the thing these tests exist to show.
 */
function env(over: Partial<EncoderEnvironment> = {}): EncoderEnvironment {
  return { platform: "linux", available: [], hasDri: false, hasQsvRuntime: false, ...over };
}

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
    const c = chooseEncoder(env({ platform: "darwin", available: parseEncoders(ENCODERS_MACOS) }));
    expect(c.encoder).toBe("h264_videotoolbox");
    expect(c.hardware).toBe(true);
    expect(c.hwaccel).toBe("videotoolbox");
    expect(c.vaapiDevice).toBeNull();
  });

  test("Linux with a render node gets VAAPI, and it names the node", () => {
    const c = chooseEncoder(env({ available: parseEncoders(ENCODERS_LINUX_VAAPI), hasDri: true }));
    expect(c.encoder).toBe("h264_vaapi");
    expect(c.vaapiDevice).toBe(VAAPI_DEVICE);
  });

  /**
   * QSV is Intel's own path and generally better at the same bitrate, but its runtime is
   * frequently missing from a container -- so it wins when present and VAAPI stays behind
   * it rather than being replaced by it.
   */
  test("QSV beats VAAPI when both are compiled in AND its runtime opens", () => {
    const c = chooseEncoder(
      env({ available: ["libx264", "h264_vaapi", "h264_qsv"], hasDri: true, hasQsvRuntime: true }),
    );
    expect(c.encoder).toBe("h264_qsv");
  });

  /**
   * THE SYNOLOGY, EXACTLY AS MEASURED 2026-09-08. Alpine's ffmpeg lists `h264_qsv` and ships
   * no libmfx, so the render node is present, the encoder is listed, and every QSV spawn dies
   * with `Error creating a MFX session: -9`. Falling through to VAAPI -- rather than to
   * software -- is what keeps 9.3x realtime on this box instead of 1.4x.
   */
  test("QSV listed with no runtime falls through to VAAPI, not to software", () => {
    const c = chooseEncoder(
      env({ available: ["libx264", "h264_vaapi", "h264_qsv"], hasDri: true, hasQsvRuntime: false }),
    );
    expect(c.encoder).toBe("h264_vaapi");
  });

  /** With nothing behind it, an unusable QSV must not take the whole choice down with it. */
  test("QSV listed with no runtime and no VAAPI falls to software", () => {
    const c = chooseEncoder(env({ available: ["libx264", "h264_qsv"], hasDri: true }));
    expect(c).toEqual(SOFTWARE);
  });

  /**
   * BEING LISTED IS NOT BEING USABLE. A build with VAAPI compiled in and no `/dev/dri`
   * fails at spawn, which is a title that will not play rather than a slow one.
   */
  test("VAAPI without a render node falls to software", () => {
    const c = chooseEncoder(env({ available: ["libx264", "h264_vaapi"] }));
    expect(c).toEqual(SOFTWARE);
  });

  test("a Linux build with no hardware encoder at all falls to software", () => {
    const c = chooseEncoder(env({ available: ["libx264"], hasDri: true }));
    expect(c).toEqual(SOFTWARE);
  });

  /** VideoToolbox is macOS-only; the name appearing on Linux would be a build oddity. */
  test("VideoToolbox is not chosen off macOS", () => {
    const c = chooseEncoder(env({ available: ["libx264", "h264_videotoolbox"] }));
    expect(c).toEqual(SOFTWARE);
  });

  /** NVENC needs no render node -- `/dev/dri` is an Intel/AMD thing. */
  test("NVENC is chosen without a render node", () => {
    const c = chooseEncoder(env({ available: ["libx264", "h264_nvenc"] }));
    expect(c.encoder).toBe("h264_nvenc");
  });

  test("an unknown platform falls to software", () => {
    const c = chooseEncoder(env({ platform: "freebsd", available: ["libx264", "h264_vaapi"], hasDri: true }));
    expect(c).toEqual(SOFTWARE);
  });

  test("every choice explains itself, because the boot log prints it", () => {
    for (const e of [
      env({ platform: "darwin", available: parseEncoders(ENCODERS_MACOS) }),
      env({ available: ["h264_vaapi"], hasDri: true }),
      env({ available: ["libx264"] }),
    ]) {
      expect(chooseEncoder(e).reason.length).toBeGreaterThan(0);
    }
  });
});

describe("probeQsvRuntime asks ffmpeg to open the device", () => {
  test("a clean exit means the runtime is there", async () => {
    const calls: string[][] = [];
    const ok = await probeQsvRuntime(async (argv) => {
      calls.push(argv);
      return { ok: true, stdout: "", stderr: "" };
    });
    expect(ok).toBe(true);
    // The whole point is that it opens a DEVICE and reads no file.
    expect(calls[0]).toContain("-init_hw_device");
    expect(calls[0]).toContain("qsv=hw");
  });

  test("a non-zero exit means it is not, and does not throw", async () => {
    const missing = await probeQsvRuntime(async () => ({
      ok: false,
      stdout: "",
      stderr: "Error creating a MFX session: -9.",
    }));
    expect(missing).toBe(false);
  });

  test("a spawn that throws is answered false rather than propagated", async () => {
    const thrown = await probeQsvRuntime(async () => {
      throw new Error("ENOENT");
    });
    expect(thrown).toBe(false);
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

  /**
   * The Synology end to end: the listing offers QSV, the device probe refuses it, VAAPI wins.
   * Two spawns, and the second one only because the first made it worth asking.
   */
  test("a listed-but-unusable QSV is probed and rejected", async () => {
    const calls: string[][] = [];
    const c = await probeEncoder({
      platform: "linux",
      hasDri: true,
      run: async (argv) => {
        calls.push(argv);
        if (argv.includes("-init_hw_device")) return { ok: false, stdout: "", stderr: "MFX session: -9" };
        return { ok: true, stdout: "", stderr: " V..... h264_qsv\n V....D h264_vaapi\n" };
      },
    });
    expect(calls).toHaveLength(2);
    expect(c.encoder).toBe("h264_vaapi");
  });

  /** The probe costs a process, so it must not run where it cannot change the answer. */
  test("QSV is not probed when the listing does not offer it", async () => {
    const calls: string[][] = [];
    await probeEncoder({
      platform: "linux",
      hasDri: true,
      run: async (argv) => {
        calls.push(argv);
        return { ok: true, stdout: ENCODERS_LINUX_VAAPI, stderr: "" };
      },
    });
    expect(calls).toHaveLength(1);
  });
});
