/**
 * Which H.264 encoder this machine should actually use.
 *
 * The answer differs by platform and it is not a preference: on the deployment NAS a
 * software encode is most of a four-thread Celeron, and on the development Mac it is most
 * of a core that Apple will do in fixed-function silicon for almost nothing. Picking wrong
 * in either direction is the difference between one concurrent viewer and several.
 *
 * ## The candidates, and why the order is what it is
 *
 * | encoder | where | notes |
 * |---|---|---|
 * | `h264_videotoolbox` | macOS, Intel and Apple Silicon | fixed-function, no device node to check |
 * | `h264_qsv` | Intel, with the QSV runtime | Intel's own path; needs libmfx/oneVPL present |
 * | `h264_vaapi` | Linux, needs `/dev/dri/renderD128` | what the Synology's UHD 600 exposes |
 * | `h264_nvenc` | NVIDIA | listed for completeness; nothing here has one |
 * | `libx264` | everywhere | the floor, and always correct |
 *
 * > [!IMPORTANT] BEING LISTED IS NOT THE SAME AS BEING USABLE, and each candidate needs its OWN evidence
 * > `ffmpeg -encoders` reports what the binary was COMPILED with, which is a different
 * > question from whether the hardware and its driver are present. `h264_vaapi` in a build
 * > with no `/dev/dri` fails at spawn; `h264_qsv` with no runtime fails the same way. So a
 * > candidate must satisfy BOTH a listing check and whatever device evidence exists for it,
 * > and where no cheap evidence exists (VideoToolbox has no device node) the platform is
 * > the evidence -- a macOS ffmpeg that lists it has it.
 * >
 * > Everything unproven falls to `libx264`, which is slow and never wrong. **Failing toward
 * > software is the correct direction**: it costs CPU, where failing the other way is a
 * > spawn error and a title that will not play at all.
 *
 * > [!CAUTION] `/dev/dri` IS EVIDENCE FOR VAAPI AND NOT FOR QSV, and conflating them shipped a broken NAS
 * > This module used to gate QSV on `hasDri` alone, which reads plausibly -- both want an
 * > Intel iGPU -- and is wrong, because the two reach it through different runtimes. VAAPI
 * > talks to the render node through libva; QSV talks to it through libmfx/oneVPL, which is a
 * > separate library that Alpine's ffmpeg is built against but does not ship.
 * >
 * > Measured on the deployment Synology (J4125, Alpine ffmpeg 6.1.2 + intel-media-driver
 * > 25.2.6, 2026-09-08): `ffmpeg -encoders` lists `h264_qsv` AND `hevc_qsv`, `/dev/dri`
 * > exists, so `chooseEncoder` chose QSV -- and every re-encode died at spawn with
 * > `Error creating a MFX session: -9`. The same box runs `h264_vaapi` at 9.3x realtime.
 * >
 * > So QSV carries `hasQsvRuntime`, and the only honest way to produce it is to ASK ffmpeg to
 * > open the device -- see `probeQsvRuntime`. A library that is either absent or present with
 * > no hardware behind it cannot be distinguished by looking at the filesystem.
 */

export type Platform = "darwin" | "linux" | (string & {});

/** What a probe found out about this machine, all of it cheap and all of it done once. */
export interface EncoderEnvironment {
  platform: Platform;
  /** Encoder names `ffmpeg -encoders` listed. */
  available: readonly string[];
  /** `/dev/dri/renderD128` exists. Linux only; meaningless elsewhere. */
  hasDri: boolean;
  /**
   * ffmpeg could actually OPEN a QSV device -- not merely that it lists the encoder.
   *
   * Its own field rather than a second reading of `hasDri`, because QSV reaches the same
   * iGPU through a different runtime (libmfx/oneVPL) that ships separately from libva. See
   * the caution at the top of this file for the deployment this distinction cost.
   */
  hasQsvRuntime: boolean;
}

export interface EncoderChoice {
  /** The `-c:v` value. */
  encoder: string;
  /** True when this is hardware; drives the log line and the health report. */
  hardware: boolean;
  /** `-hwaccel` value, when the decode side should be accelerated too. */
  hwaccel: string | null;
  /** VAAPI alone needs its device named and its frames uploaded. */
  vaapiDevice: string | null;
  /** One line, for the boot log and `/api/health`. */
  reason: string;
}

export const SOFTWARE: EncoderChoice = {
  encoder: "libx264",
  hardware: false,
  hwaccel: null,
  vaapiDevice: null,
  reason: "software (libx264) -- no usable hardware encoder found",
};

export const VAAPI_DEVICE = "/dev/dri/renderD128";

/**
 * Pick an encoder. PURE, so every platform's answer is testable from one machine.
 *
 * Ordered best-first per platform rather than as one global list, because "best" genuinely
 * differs: VideoToolbox is the only hardware path on macOS, and on Linux QSV and VAAPI can
 * both be present on the same Intel chip while only one of them has a working runtime.
 */
export function chooseEncoder(env: EncoderEnvironment): EncoderChoice {
  const has = (name: string) => env.available.includes(name);

  if (env.platform === "darwin" && has("h264_videotoolbox")) {
    return {
      encoder: "h264_videotoolbox",
      hardware: true,
      // Decode acceleration too: on Apple Silicon the HEVC decoder is the expensive half of
      // an HEVC-to-h264 job, and it is the same fixed-function block.
      hwaccel: "videotoolbox",
      vaapiDevice: null,
      reason: "hardware (VideoToolbox)",
    };
  }

  if (env.platform === "linux" && env.hasDri) {
    // QSV FIRST on Intel: it is Intel's own path and generally encodes better at the same
    // bitrate than the generic VAAPI one, but it needs a runtime that is frequently absent
    // from a container, so VAAPI stays behind it rather than being replaced by it.
    //
    // `hasQsvRuntime` and not `hasDri` is what makes that fallback actually happen: the
    // render node is evidence for libva, and QSV needs libmfx. Alpine's ffmpeg lists the
    // encoder and ships neither.
    if (has("h264_qsv") && env.hasQsvRuntime) {
      return {
        encoder: "h264_qsv",
        hardware: true,
        hwaccel: "qsv",
        vaapiDevice: null,
        reason: `hardware (Intel QuickSync, ${VAAPI_DEVICE})`,
      };
    }
    if (has("h264_vaapi")) {
      return {
        encoder: "h264_vaapi",
        hardware: true,
        hwaccel: "vaapi",
        vaapiDevice: VAAPI_DEVICE,
        reason: `hardware (VAAPI, ${VAAPI_DEVICE})`,
      };
    }
  }

  // NVENC needs no device node of its own and is not gated on `/dev/dri`, which is an
  // Intel/AMD render node. Nothing in this deployment has one; it is here so a machine that
  // does is not silently pushed to software.
  if (env.platform === "linux" && has("h264_nvenc")) {
    return {
      encoder: "h264_nvenc",
      hardware: true,
      hwaccel: "cuda",
      vaapiDevice: null,
      reason: "hardware (NVIDIA NVENC)",
    };
  }

  return SOFTWARE;
}

/** How a probe reaches ffmpeg. Injected so tests need no binary. */
export type FfmpegRunner = (argv: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/**
 * Ask ffmpeg to OPEN a QSV device, which is the only thing that answers the question.
 *
 * `-init_hw_device` is a GLOBAL option, so this opens the runtime and exits without an input
 * file, an output file or a frame -- there is nothing cheaper that still touches libmfx.
 * Measured on the Synology 2026-09-08: exit 171 with `Error creating a MFX session: -9` where
 * the same shape against `vaapi` exits 0.
 *
 * Exported for the test, and for anybody who needs the fact without the whole choice.
 */
export async function probeQsvRuntime(run: FfmpegRunner): Promise<boolean> {
  try {
    const res = await run([
      "-hide_banner",
      "-loglevel",
      "error",
      "-init_hw_device",
      "qsv=hw",
      "-f",
      "null",
      "-",
    ]);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ask ffmpeg what it can do, once, at boot.
 *
 * The encoder list is a property of the binary and the device node is a property of the
 * kernel; neither changes while this process runs, so probing per session would be a
 * syscall answering a question whose answer we already had.
 *
 * The QSV runtime probe is SKIPPED unless it could change the answer -- a Linux box with a
 * render node and `h264_qsv` in the listing. Everywhere else the second spawn would be a
 * process started to confirm something already decided.
 */
export async function probeEncoder(
  opts: { platform?: Platform; hasDri?: boolean; run?: FfmpegRunner } = {},
): Promise<EncoderChoice> {
  const platform = opts.platform ?? process.platform;
  const run =
    opts.run ??
    (async (argv: string[]) => {
      const proc = Bun.spawn(["ffmpeg", ...argv], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { ok: code === 0, stdout, stderr };
    });

  let hasDri = opts.hasDri;
  if (hasDri === undefined) {
    const { existsSync } = await import("node:fs");
    hasDri = existsSync(VAAPI_DEVICE);
  }

  try {
    const res = await run(["-hide_banner", "-encoders"]);
    const available = parseEncoders(res.stdout + res.stderr);
    const qsvCouldWin = platform === "linux" && hasDri && available.includes("h264_qsv");
    const hasQsvRuntime = qsvCouldWin ? await probeQsvRuntime(run) : false;
    return chooseEncoder({ platform, available, hasDri, hasQsvRuntime });
  } catch {
    // No ffmpeg. Playback fails later with a message about the file; nothing useful to add.
    return SOFTWARE;
  }
}

/**
 * Pull encoder names out of `ffmpeg -encoders`.
 *
 * Lines look like ` V....D h264_videotoolbox    VideoToolbox H.264 Encoder (codec h264)`.
 * The name is the second whitespace-separated field on a line whose first field is the
 * flag block; a header or a blank line has no second field and falls out on its own.
 */
export function parseEncoders(out: string): string[] {
  const names: string[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*[VAS.][^\s]{5}\s+(\S+)/.exec(line);
    if (m?.[1]) names.push(m[1]);
  }
  return names;
}
