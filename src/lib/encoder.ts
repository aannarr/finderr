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
 * > [!IMPORTANT] BEING LISTED IS NOT THE SAME AS BEING USABLE, and only one of these can be checked cheaply
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
 */

export type Platform = "darwin" | "linux" | (string & {});

/** What a probe found out about this machine, all of it cheap and all of it done once. */
export interface EncoderEnvironment {
  platform: Platform;
  /** Encoder names `ffmpeg -encoders` listed. */
  available: readonly string[];
  /** `/dev/dri/renderD128` exists. Linux only; meaningless elsewhere. */
  hasDri: boolean;
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
    if (has("h264_qsv")) {
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

/**
 * Ask ffmpeg what it can do, once, at boot.
 *
 * The encoder list is a property of the binary and the device node is a property of the
 * kernel; neither changes while this process runs, so probing per session would be a
 * syscall answering a question whose answer we already had.
 */
export async function probeEncoder(
  opts: {
    platform?: Platform;
    hasDri?: boolean;
    run?: (argv: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  } = {},
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
    return chooseEncoder({ platform, available: parseEncoders(res.stdout + res.stderr), hasDri });
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
