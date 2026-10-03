// download-worker.mjs - a tiny Cloudflare Worker that lets the Jonah website show a LIVE download percentage.
//
// WHY: a web page can only watch a download's progress if the file's server allows it ("CORS"). GitHub's release downloads do not, so
// with GitHub alone the website can only hand the file to the browser. This Worker fetches the file from GitHub for the visitor and
// adds the two things the page needs: permission for the website to read it, and the file size. It stores nothing.
//
// SAFE BY DESIGN:
//   * It only ever fetches from ONE fixed GitHub repository (below), so it cannot be used as an open proxy.
//   * Only file names that look like Jonah's own release files are served (installers, DMGs, update packages); anything else is a 404.
//   * Only the Jonah website addresses below may read the download from a page; any other website gets a 403.
//
// SET UP (about 5 minutes, free):
//   1. dash.cloudflare.com -> Workers & Pages -> Create -> Worker. Name it e.g. "jonah-downloads". Deploy, then "Edit code".
//   2. Paste this whole file in (replace the default code) and click Deploy.
//   3. Copy the Worker address (https://jonah-downloads.<your-name>.workers.dev).
//   4. In website/index.html set   downloadBase: "https://jonah-downloads.<your-name>.workers.dev"
//   Downloads then run through this Worker: the page shows percent, MB, speed and time left.
//   (Cloudflare's free plan allows 100,000 Worker requests a day; the file bytes themselves are not billed.)
//
// URL shape: /<tag>/<file>      e.g. /v1.4.4/Jonah-1.4.4-arm64.dmg      ("latest" works as the tag too)

const REPO = "213213ekei34243255/299239404503yuios9293923045949932i-253547869";
const ALLOWED_ORIGINS = [
  "https://www.jonahbrowser.store", "https://jonahbrowser.store",
  "https://www.jonahbrowser.com", "https://jonahbrowser.com",
];
// Jonah's own release files only: Jonah-<version>-<arch>.dmg|zip, Jonah-Web-Setup-<version>.exe, jonah-<version>-x64.nsis.7z, the Mac installer.
const FILE_OK = /^(?:Jonah-[0-9][0-9A-Za-z.+-]*\.(?:dmg|zip|exe)|Jonah-(?:Web-)?Setup-[0-9][0-9A-Za-z.+-]*\.exe|jonah-[0-9][0-9A-Za-z.+-]*\.nsis\.7z|Jonah-Mac-Installer\.zip|install-jonah-mac\.command)$/;
const PATH_OK = /^\/(latest|v[0-9]+\.[0-9]+\.[0-9]+(?:[-.][0-9A-Za-z.]+)?)\/([A-Za-z0-9._+-]{1,120})$/;

export function route(pathname) {
  const m = PATH_OK.exec(pathname);
  if (!m || !FILE_OK.test(m[2])) return null;
  const [, tag, file] = m;
  return { tag, file, upstream: tag === "latest"
    ? `https://github.com/${REPO}/releases/latest/download/${file}`
    : `https://github.com/${REPO}/releases/download/${tag}/${file}` };
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin");
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response("This website may not use this download service.", { status: 403 });
    const cors = {
      "Access-Control-Allow-Origin": origin || "*",
      "Access-Control-Expose-Headers": "Content-Length, Content-Disposition",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Max-Age": "86400" } });
    if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: cors });

    const r = route(new URL(request.url).pathname);
    if (!r) return new Response("Not found", { status: 404, headers: cors });

    let upstream;
    try { upstream = await fetch(r.upstream, { method: request.method, redirect: "follow" }); }
    catch (e) { return new Response("Could not reach the download server.", { status: 502, headers: cors }); }
    if (!upstream.ok) return new Response("Not found", { status: upstream.status === 404 ? 404 : 502, headers: cors });

    const headers = new Headers(cors);
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Disposition", `attachment; filename="${r.file}"`);
    headers.set("Cache-Control", r.tag === "latest" ? "public, max-age=300" : "public, max-age=3600");
    const len = upstream.headers.get("Content-Length");
    if (len) headers.set("Content-Length", len); // this is what lets the page show a real percentage
    return new Response(request.method === "HEAD" ? null : upstream.body, { status: 200, headers });
  },
};
