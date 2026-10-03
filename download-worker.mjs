// download-worker.mjs - Jonah's download service (a small Cloudflare Worker).
//
// WHAT IT DOES: the website talks only to this service. It tells the page which version is current and streams the installer to the
// visitor, adding what a web page needs to show a LIVE percentage (permission to read the download, and the file size).
// The page never sees where the files are stored: no repository name and no storage address is in the website's code.
//
// WHERE THE REPOSITORY NAME LIVES: in a Cloudflare setting called REPO, never in this file (see step 3 below), so this code can be
// shared or pasted anywhere without revealing it.
//
// SAFE BY DESIGN:
//   * It serves ONLY the four named downloads below (Windows installer, Mac Apple Silicon, Mac Intel, Mac installer) from the one
//     repository in REPO. It cannot be used to fetch anything else, so it is not an open proxy.
//   * Only the Jonah website addresses may read a download from a page; any other website gets a 403.
//   * It stores nothing.
//
// SET UP (about 5 minutes, free):
//   1. dash.cloudflare.com -> Workers & Pages -> Create -> Worker. Name it e.g. "jonah-downloads". Deploy, then "Edit code".
//   2. Paste this whole file in (replace the default code) and click Deploy.
//   3. Worker -> Settings -> Variables and Secrets -> Add:
//        REPO            (type: Secret)   OWNER/REPOSITORY of the releases, e.g. your-user/your-repo      <- required
//        GITHUB_TOKEN    (type: Secret)   OPTIONAL. A read-only GitHub token. Only needed if GitHub's anonymous limit (60 lookups an
//                                         hour per Cloudflare address) is ever hit; not needed for a public repository.
//        ALLOWED_ORIGINS (type: Text)     OPTIONAL. Comma-separated website addresses allowed to read downloads. Defaults to the
//                                         jonahbrowser.store / jonahbrowser.com addresses below.
//   4. Copy the Worker address (https://jonah-downloads.<your-name>.workers.dev), or attach your own domain to it, and put it in
//      website/index.html:   api: "https://jonah-downloads.<your-name>.workers.dev"
//
// ADDRESSES:   GET /api/latest          -> {"version":"1.4.4","assets":{"win":{"name":"...","size":123}, ...}}
//              GET /download/<key>      -> the file.  <key> is one of: win, macArm, macIntel, macInstaller

const DEFAULT_ORIGINS = ["https://www.jonahbrowser.store", "https://jonahbrowser.store", "https://www.jonahbrowser.com", "https://jonahbrowser.com"];

// which release file each download key means (matched against the newest published release's file names)
export const PICK = {
  win: [/^Jonah-Web-Setup-.*\.exe$/i, /Setup.*\.exe$/i],
  macArm: [/arm64\.dmg$/i],
  macIntel: [/(?:x64|intel)\.dmg$/i, /^Jonah-\d[\d.]*\.dmg$/i],
  macInstaller: [/^Jonah-Mac-Installer\.zip$/i],
};
export const KEYS = Object.keys(PICK);

export function pickAssets(assets) {
  const out = {};
  for (const key of KEYS) {
    for (const re of PICK[key]) {
      const a = (assets || []).find((x) => x && typeof x.name === "string" && re.test(x.name));
      if (a) { out[key] = { name: a.name, size: a.size, url: a.browser_download_url }; break; }
    }
  }
  return out;
}

export function route(pathname) {
  if (pathname === "/api/latest") return { type: "latest" };
  const m = /^\/download\/([A-Za-z]{1,16})$/.exec(pathname);
  if (m && KEYS.includes(m[1])) return { type: "download", key: m[1] };
  return null;
}

const REPO_OK = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

async function latestRelease(env) {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "jonah-downloads" };
  if (env.GITHUB_TOKEN) headers.Authorization = "Bearer " + env.GITHUB_TOKEN;
  const r = await fetch("https://api.github.com/repos/" + env.REPO + "/releases/latest", { headers, cf: { cacheTtl: 300, cacheEverything: true } });
  if (!r.ok) throw new Error("release list answered " + r.status);
  const rel = await r.json();
  return { version: String(rel.tag_name || "").replace(/^v/, ""), assets: pickAssets(rel.assets) };
}

export default {
  async fetch(request, env = {}) {
    const allowed = env.ALLOWED_ORIGINS ? String(env.ALLOWED_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_ORIGINS;
    const origin = request.headers.get("Origin");
    if (origin && !allowed.includes(origin)) return new Response("This website may not use this download service.", { status: 403 });
    const cors = { "Access-Control-Allow-Origin": origin || "*", "Access-Control-Expose-Headers": "Content-Length, Content-Disposition", "Vary": "Origin" };

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Max-Age": "86400" } });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: cors });

    const r = route(new URL(request.url).pathname);
    if (!r) return new Response("Not found", { status: 404, headers: cors });
    if (!REPO_OK.test(String(env.REPO || ""))) return new Response("Download service is not configured.", { status: 503, headers: cors });

    let rel;
    try { rel = await latestRelease(env); } catch (e) { return new Response("Could not reach the release list.", { status: 502, headers: cors }); }

    if (r.type === "latest") {
      const assets = {};
      for (const k of Object.keys(rel.assets)) assets[k] = { name: rel.assets[k].name, size: rel.assets[k].size }; // names and sizes only: no addresses
      return new Response(JSON.stringify({ version: rel.version, assets }), { status: 200, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" } });
    }

    const asset = rel.assets[r.key];
    if (!asset || !asset.url) return new Response("Not found", { status: 404, headers: cors });
    let upstream;
    try { upstream = await fetch(asset.url, { method: request.method, redirect: "follow" }); } catch (e) { return new Response("Could not reach the download server.", { status: 502, headers: cors }); }
    if (!upstream.ok) return new Response("Not found", { status: upstream.status === 404 ? 404 : 502, headers: cors });

    const headers = new Headers(cors);
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Disposition", `attachment; filename="${asset.name.replace(/[^A-Za-z0-9._+-]/g, "_")}"`);
    headers.set("Cache-Control", "public, max-age=300");
    const len = upstream.headers.get("Content-Length");
    if (len) headers.set("Content-Length", len); // this is what lets the page show a real percentage
    return new Response(request.method === "HEAD" ? null : upstream.body, { status: 200, headers });
  },
};
