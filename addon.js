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
  catalogs: []
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
        return require(path.join(providersDir, file));
      } catch (err) {
        console.error(`Failed to load provider ${file}:`, err);
        return null;
      }
    })
    .filter(provider => provider && typeof provider.getStreams === "function");
}

// --- Stream handler
// Resolve Stremio IMDb identifiers to the TMDB IDs used by Nuvio providers.
// Preserve the upstream default key; allow a personal key through host settings.
const tmdbKey = process.env.TMDB_API_KEY || "439c478a771f35c05022f9feabcca01c";
async function streamHandler({ id, type }) {
  const match = /^(tt\d+)(?::(\d+):(\d+))?$/.exec(id);
  if (!match || !["movie", "series"].includes(type)) return { streams: [] };
  if (type === "series" && (!match[2] || !match[3])) return { streams: [] };
  const response = await fetch(`https://api.themoviedb.org/3/find/${match[1]}?api_key=${encodeURIComponent(tmdbKey)}&external_source=imdb_id`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`TMDB lookup failed: ${response.status}`);
  const data = await response.json();
  const media = (type === "series" ? data.tv_results : data.movie_results)?.[0];
  if (!media) return { streams: [] };
  const results = await Promise.all(providers.map(async provider => {
    let timer;
    try {
      return await Promise.race([
        provider.getStreams(String(media.id), type === "series" ? "tv" : "movie", match[2] ? Number(match[2]) : null, match[3] ? Number(match[3]) : null),
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

  // Call the proper Vercel-compatible handler
  router(req, res, () => { res.statusCode = 404; res.end("Not found"); });
};

if (require.main === module) require("http").createServer(module.exports).listen(process.env.PORT || 7000);
