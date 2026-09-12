const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const fs = require("fs");
const path = require("path");

// --- Manifest
const manifest = {
  id: "community.nuvio.searchonly",
  version: "1.0.0",
  name: "Nuvio Search Streams",
  description: "Search-only addon using all Nuvio providers",
  resources: ["stream"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  behaviorHints: { configurable: true },
  config: [{ key: "providers", type: "text", title: "Provider priority" }]
};

const builder = new addonBuilder(manifest);

// --- Load all providers dynamically
const providersDir = path.join(__dirname, "providers");
let providers = [];

if (fs.existsSync(providersDir)) {
  providers = fs
    .readdirSync(providersDir)
    .filter(file => file.endsWith(".js"))
    .map(file => {
      try {
        return { id: path.basename(file, ".js"), module: require(path.join(providersDir, file)) };
      } catch (err) {
        console.error(`Failed to load provider ${file}:`, err);
        return null;
      }
    })
    .filter(provider => provider && typeof provider.module.getStreams === "function");
}

// --- Stream handler
// Resolve Stremio IMDb identifiers to the TMDB IDs used by Nuvio providers.
// Preserve the upstream default key; allow a personal key through host settings.
const tmdbKey = process.env.TMDB_API_KEY || "439c478a771f35c05022f9feabcca01c";
async function streamHandler({ id, type, config = {} }) {
  const match = /^(tt\d+)(?::(\d+):(\d+))?$/.exec(id);
  if (!match || !["movie", "series"].includes(type)) return { streams: [] };
  if (type === "series" && (!match[2] || !match[3])) return { streams: [] };
  const response = await fetch(`https://api.themoviedb.org/3/find/${match[1]}?api_key=${encodeURIComponent(tmdbKey)}&external_source=imdb_id`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`TMDB lookup failed: ${response.status}`);
  const data = await response.json();
  const media = (type === "series" ? data.tv_results : data.movie_results)?.[0];
  if (!media) return { streams: [] };
  const requested = Array.isArray(config.providers) ? config.providers : [];
  const enabled = requested.length
    ? requested.map(providerId => providers.find(provider => provider.id === providerId)).filter(Boolean)
    : providers;
  const results = await Promise.all(enabled.map(async provider => {
    let timer;
    try {
      return await Promise.race([
        provider.module.getStreams(String(media.id), type === "series" ? "tv" : "movie", match[2] ? Number(match[2]) : null, match[3] ? Number(match[3]) : null),
        new Promise(resolve => { timer = setTimeout(() => resolve([]), 20000); })
      ]);
    } catch (error) {
      console.error("Provider failed:", error.message);
      return [];
    } finally { clearTimeout(timer); }
  }));
  return { streams: results.flatMap(result => Array.isArray(result) ? result : result?.streams || [])
    .filter(stream => stream && typeof stream.url === "string" && /^https?:\/\//.test(stream.url)) };
}
builder.defineStreamHandler(streamHandler);

// --- HTTP handler for Vercel and traditional Node hosts
const router = getRouter(builder.getInterface());

module.exports = (req, res) => {
  // Handle favicon gracefully
  if (req.url === "/favicon.ico") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.url === "/" || req.url.startsWith("/configure")) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(configurationPage());
    return;
  }

  // Call the proper Vercel-compatible handler
  router(req, res, () => { res.statusCode = 404; res.end("Not found"); });
};

function configurationPage() {
  const providerIds = providers.map(provider => provider.id);
  const labels = Object.fromEntries(providerIds.map(id => [id, id
    .replace(/(^|[-_])(\w)/g, (_, separator, letter) => `${separator ? " " : ""}${letter.toUpperCase()}`)]));
  labels.hdrezka = "HDRezka";
  labels["4khdhub"] = "4KHDHub";
  const rows = providerIds.map(id => `<li data-id="${id}"><label><input type="checkbox" checked> <span>${labels[id]}</span></label><div><button type="button" class="up" aria-label="Move ${labels[id]} up">↑</button><button type="button" class="down" aria-label="Move ${labels[id]} down">↓</button></div></li>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Configure Nuvio Streams</title><style>
  :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#101217;color:#f4f5f7}body{max-width:680px;margin:0 auto;padding:28px 18px 60px}h1{font-size:1.7rem;margin-bottom:6px}p{color:#aeb4c0;line-height:1.5}ul{list-style:none;padding:0;margin:22px 0}li{display:flex;justify-content:space-between;align-items:center;background:#1a1e26;border:1px solid #303641;border-radius:10px;padding:11px 12px;margin:8px 0}label{display:flex;gap:9px;align-items:center;font-weight:600}button,a.action{border:0;border-radius:8px;background:#303744;color:#fff;padding:8px 11px;cursor:pointer}.up,.down{margin-left:5px;font-size:1rem}#install{display:inline-block;background:#7257ff;color:white;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:9px}.copy{margin-left:8px}code{display:block;overflow-wrap:anywhere;background:#171a21;padding:12px;border-radius:8px;margin-top:14px;color:#cbd1dc}</style></head><body>
  <h1>Configure Nuvio Streams</h1><p>Enable the sources you want. Results follow this priority from top to bottom.</p><ul id="providers">${rows}</ul><a id="install" class="action">Install in Stremio</a><button id="copy" class="copy">Copy manifest URL</button><code id="url"></code>
  <script>const list=document.querySelector('#providers'),url=document.querySelector('#url');function manifest(){const providers=[...list.children].filter(row=>row.querySelector('input').checked).map(row=>row.dataset.id);return location.origin+'/'+encodeURIComponent(JSON.stringify({providers}))+'/manifest.json'}function refresh(){url.textContent=manifest();document.querySelector('#install').href=manifest().replace(/^https?:\/\//,'stremio://')}list.addEventListener('click',event=>{const row=event.target.closest('li');if(!row)return;if(event.target.classList.contains('up')&&row.previousElementSibling)list.insertBefore(row,row.previousElementSibling);if(event.target.classList.contains('down')&&row.nextElementSibling)list.insertBefore(row.nextElementSibling,row);refresh()});list.addEventListener('change',refresh);document.querySelector('#copy').onclick=()=>navigator.clipboard.writeText(manifest()).then(()=>{document.querySelector('#copy').textContent='Copied'});refresh();</script></body></html>`;
}

if (require.main === module) require("http").createServer(module.exports).listen(process.env.PORT || 7000);
