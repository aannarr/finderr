/**
 * How long a player waits for media, measured against a RUNNING finderr.
 *
 * Starts a playback session for one title, then walks its segments the way hls.js does -- the
 * video rendition and the default audio rendition in parallel, one request at a time on each,
 * retrying a 404 ("not ready") -- and reports, per segment, how long it took from asking to
 * holding the whole body, plus how long until 30 s and 60 s of media were in hand. Then it
 * reads what ffmpeg cost from `/api/admin/playback/cost` and stops the session.
 *
 * It measures the SERVER as a player sees it, which is why it is a client rather than a call
 * into `TranscodeSessions`: routing, auth, the zero-copy file handoff and the transfer are all
 * part of what a viewer waits for. Where it runs decides whether the network is in the number
 * -- inside the container (`docker exec -i finderr bun run - < src/jobs/bench-playback.ts`)
 * it is not; from another machine on the LAN it is. Say which when quoting a result.
 *
 * COLD means a title nobody has played recently: the array's page cache is the largest effect
 * on the first segments, so re-running one title measures the cache, not the change.
 *
 * Configuration is environment-only so the stdin form works unchanged:
 *
 *   BENCH_URL      base URL (default http://localhost:7979)
 *   BENCH_KEY      admin bearer key (falls back to FINDERR_ADMIN_API_KEY, then ADMIN_API_KEY)
 *   BENCH_TITLES   comma-separated tconsts, run one after another
 *   BENCH_CAPS     "copy" (h264+hevc, aac: video copied) or "h264" (h264 only: hevc re-encodes)
 *   BENCH_SECONDS  media seconds to walk (default 90)
 *   BENCH_SETTLE_MS  wait before reading the cost report, so a background run is charged (5000)
 */

export {};

interface Rendition {
  name: string;
  init: string | null;
  segments: { uri: string; sec: number }[];
}

const base = (process.env.BENCH_URL ?? "http://localhost:7979").replace(/\/$/, "");
const key = process.env.BENCH_KEY ?? process.env.FINDERR_ADMIN_API_KEY ?? process.env.ADMIN_API_KEY ?? "";
const titles = (process.env.BENCH_TITLES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const caps =
  process.env.BENCH_CAPS === "h264"
    ? { video: ["h264"], audio: ["aac"] }
    : { video: ["h264", "hevc"], audio: ["aac"] };
const walkSeconds = Number(process.env.BENCH_SECONDS ?? 90);
const settleMs = Number(process.env.BENCH_SETTLE_MS ?? 5000);
/** How long one segment may keep answering 404 before the walk gives up on it. */
const SEGMENT_GIVE_UP_MS = 60_000;
const RETRY_MS = 250;

const auth = { authorization: `Bearer ${key}` };

function attr(line: string, name: string): string | null {
  return line.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
}

async function text(path: string): Promise<string> {
  const res = await fetch(`${base}${path}`, { headers: auth });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.text();
}

function parseMedia(name: string, body: string): Rendition {
  const lines = body.split("\n");
  let init: string | null = null;
  const segments: Rendition["segments"] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("#EXT-X-MAP:")) init = attr(line, "URI");
    if (line.startsWith("#EXTINF:")) {
      segments.push({ uri: (lines[i + 1] ?? "").trim(), sec: Number.parseFloat(line.slice(8)) });
    }
  }
  return { name, init, segments };
}

/** One GET that retries "not ready" like a player, timed until the body is fully read. */
async function fetchUntilReady(url: string): Promise<{ ms: number; bytes: number; tries: number }> {
  const start = performance.now();
  let tries = 0;
  while (true) {
    tries++;
    // The bearer as well as the `?t=` token: the auth wrapper around the route table refuses
    // an unauthenticated request before the playback handler can admit the stream token.
    const res = await fetch(url, { headers: auth });
    if (res.ok) {
      const bytes = (await res.arrayBuffer()).byteLength;
      return { ms: performance.now() - start, bytes, tries };
    }
    await res.arrayBuffer();
    if (res.status !== 404 || performance.now() - start > SEGMENT_GIVE_UP_MS) {
      throw new Error(`${url}: HTTP ${res.status} after ${tries} tries`);
    }
    await Bun.sleep(RETRY_MS);
  }
}

async function runTitle(tconst: string): Promise<void> {
  const t0 = performance.now();
  const startRes = await fetch(`${base}/api/play/${tconst}/session`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ capabilities: caps }),
  });
  if (!startRes.ok) throw new Error(`${tconst}: start HTTP ${startRes.status} ${await startRes.text()}`);
  const started = (await startRes.json()) as {
    sessionId: string;
    playlist: string;
    streamToken: string;
    plan: { video: { action: string } | null };
  };
  const startMs = performance.now() - t0;
  const dir = started.playlist.slice(0, started.playlist.lastIndexOf("/") + 1);
  const q = `?t=${encodeURIComponent(started.streamToken)}`;

  try {
    const master = (await text(started.playlist)).split("\n");
    const audioLine = master.find(
      (l) => l.startsWith("#EXT-X-MEDIA:") && l.includes("TYPE=AUDIO") && l.includes("DEFAULT=YES"),
    );
    const variantAt = master.findIndex((l) => l.startsWith("#EXT-X-STREAM-INF"));
    const names = [master[variantAt + 1]?.trim(), audioLine ? attr(audioLine, "URI") : null].filter(
      (n): n is string => Boolean(n),
    );
    const renditions = await Promise.all(names.map(async (n) => parseMedia(n, await text(`${dir}${n}`))));

    // Media seconds in hand per rendition, and when each threshold was crossed by ALL of them.
    const have = new Map<string, number>(renditions.map((r) => [r.name, 0]));
    const crossed: Record<string, number | null> = { 30: null, 60: null };
    const note = () => {
      const least = Math.min(...have.values());
      for (const mark of Object.keys(crossed)) {
        if (crossed[mark] === null && least >= Number(mark)) crossed[mark] = performance.now() - t0;
      }
    };

    const rows: { rendition: string; index: number; ms: number; bytes: number; tries: number }[] = [];
    await Promise.all(
      renditions.map(async (r) => {
        if (r.init) await fetchUntilReady(`${base}${dir}${r.init}${q}`);
        let seconds = 0;
        for (let i = 0; i < r.segments.length && seconds < walkSeconds; i++) {
          const seg = r.segments[i];
          if (!seg) break;
          const got = await fetchUntilReady(`${base}${dir}${seg.uri}${q}`);
          rows.push({ rendition: r.name, index: i, ...got });
          seconds += seg.sec;
          have.set(r.name, seconds);
          note();
        }
      }),
    );

    await Bun.sleep(settleMs);
    const cost = (await (await fetch(`${base}/api/admin/playback/cost`, { headers: auth })).json()) as {
      sessions?: { sessionId?: string; id?: string; cpuMs: number; bytes: number }[];
    };
    const mine = cost.sessions?.find((s) => (s.sessionId ?? s.id) === started.sessionId);

    const pct = (xs: number[], p: number) => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0;
    };
    const video = rows.filter((r) => r.rendition === renditions[0]?.name).map((r) => r.ms);
    const summary = {
      tconst,
      mode: started.plan.video?.action === "transcode" ? "video-transcode" : "video-copy",
      at: base,
      startMs: Math.round(startMs),
      t30Ms: crossed[30] === null ? null : Math.round(crossed[30]),
      t60Ms: crossed[60] === null ? null : Math.round(crossed[60]),
      segMs: {
        p50: Math.round(pct(video, 50)),
        p90: Math.round(pct(video, 90)),
        max: Math.round(Math.max(...video)),
      },
      retries404: rows.reduce((n, r) => n + r.tries - 1, 0),
      mb: Math.round(rows.reduce((n, r) => n + r.bytes, 0) / 1048576),
      ffmpegCpuMs: mine?.cpuMs ?? null,
    };
    for (const r of renditions) {
      const line = rows
        .filter((x) => x.rendition === r.name)
        .sort((a, b) => a.index - b.index)
        .map((x) => `${x.index}:${Math.round(x.ms)}${x.tries > 1 ? `(${x.tries})` : ""}`)
        .join(" ");
      console.log(`${tconst} ${r.name} ms/segment: ${line}`);
    }
    console.log(JSON.stringify(summary));
  } finally {
    await fetch(`${base}/api/play/s/${started.sessionId}`, { method: "DELETE", headers: auth });
  }
}

if (!key || titles.length === 0) {
  console.error("BENCH_TITLES and an admin key (BENCH_KEY / FINDERR_ADMIN_API_KEY) are required");
  process.exit(2);
}
for (const tconst of titles) await runTitle(tconst);
