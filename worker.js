export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(htmlPage(env), {
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }

    if (request.method === "POST" && url.pathname === "/process") {
      // REQUIRED env
      if (!env.OPENAI_API_KEY) return text("Missing OPENAI_API_KEY", 500);
      if (!env.IMAGE_BASE_URL) return text("Missing IMAGE_BASE_URL", 500);

      // UI inputs
      const form = await request.formData();
      const folder = (form.get("folder") || "").toString().trim();
      const startId = Number((form.get("startId") || "").toString().trim());
      const endId = Number((form.get("endId") || "").toString().trim());

      const allowedFolders = new Set(["vinyl_lp", "vinyl_45", "cd", "cassette"]);
      if (!allowedFolders.has(folder)) return text("Bad folder", 400);
      if (!Number.isFinite(startId) || !Number.isFinite(endId) || startId <= 0 || endId <= 0 || endId < startId) {
        return text("Bad ID range", 400);
      }

      // hard limits so you don’t nuke your own server
      const MAX_ITEMS = 200;      // max IDs per run
      const MAX_IMAGES = 8;       // per item
      const CONCURRENCY = 8;      // parallel HEADs

      const ids = [];
      for (let i = startId; i <= endId && ids.length < MAX_ITEMS; i++) ids.push(i);

      const TYPE_RULES = {
        vinyl_lp: { category: "Music", subcategory: "Vinyl Records", price: 5, shipping: "1 lb", label: "LP vinyl record" },
        vinyl_45: { category: "Music", subcategory: "Vinyl Records", price: 3, shipping: "4-7 oz", label: "45 rpm vinyl record" },
        cd: { category: "Music", subcategory: "CDs & Cassettes", price: 3, shipping: "4-7 oz", label: "CD" },
        cassette: { category: "Music", subcategory: "CDs & Cassettes", price: 3, shipping: "4-7 oz", label: "Music cassette tape" },
      };

      const DEFAULTS = {
        quantity: 1,
        type: "Auction",
        offerable: "TRUE",
        hazmat: "Not Hazmat",
        condition: "",
        costPerItem: "",
      };

      const base = env.IMAGE_BASE_URL.replace(/\/+$/, ""); // no trailing slash
      const rows = [];

      // Find which IDs exist by checking _1.jpg
      const exists = await headScan(ids, CONCURRENCY, (id) => `${base}/${folder}/${id}_1.jpg`);

      for (const id of exists) {
        // Collect up to 8 images (stop when a slot missing)
        const imageUrls = [];
        for (let seq = 1; seq <= MAX_IMAGES; seq++) {
          const u = `${base}/${folder}/${id}_${seq}.jpg`;
          const ok = await headOk(u);
          if (!ok) break;
          imageUrls.push(u);
        }

        const rule = TYPE_RULES[folder];

        // AI pulls artist/title from the FIRST image URL
        const ai = await readMusicFromImage(env, imageUrls[0] || "");

        const title = clamp50(noEmoji(`${ai.artist} ${ai.title} ${rule.label}`.trim())) ||
                      clamp50(noEmoji(`${rule.label} ${id}`));

        const description = clampDesc(noEmoji(`${ai.artist} - ${ai.title}. See photos. Ships fast.`));

        rows.push({
          Category: rule.category,
          "Sub Category": rule.subcategory,
          Title: title,
          Description: description,
          Quantity: DEFAULTS.quantity,
          Type: DEFAULTS.type,
          Price: rule.price,
          "Shipping Profile": rule.shipping,
          Offerable: DEFAULTS.offerable,
          Hazmat: DEFAULTS.hazmat,
          Condition: DEFAULTS.condition,
          "Cost Per Item": DEFAULTS.costPerItem,
          SKU: String(id),
          ...toImageCols(imageUrls),
        });
      }

      const headers = [
        "Category",
        "Sub Category",
        "Title",
        "Description",
        "Quantity",
        "Type",
        "Price",
        "Shipping Profile",
        "Offerable",
        "Hazmat",
        "Condition",
        "Cost Per Item",
        "SKU",
        "Image URL 1",
        "Image URL 2",
        "Image URL 3",
        "Image URL 4",
        "Image URL 5",
        "Image URL 6",
        "Image URL 7",
        "Image URL 8",
      ];

      const csv = toCsv(headers, rows);

      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=UTF-8",
          "content-disposition": `attachment; filename="whatnot_upload.csv"`,
        },
      });
    }

    return text("Not found", 404);
  },
};

function htmlPage(env) {
  const base = (env.IMAGE_BASE_URL || "http://24.158.206.165:12345").replace(/\/+$/, "");
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Whatnot Lister v2</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#fff;}
    .wrap{max-width:900px;margin:40px auto;padding:0 16px;}
    h1{font-size:34px;margin:0 0 16px;}
    .card{border:1px solid #e6e6e6;border-radius:14px;padding:14px;margin:12px 0;}
    label{display:block;font-weight:600;margin:10px 0 6px;}
    input,select{width:100%;padding:12px;border-radius:10px;border:1px solid #ccc;font-size:16px;}
    button{font-size:18px;padding:14px 18px;border-radius:12px;border:1px solid #ddd;background:#f4f4f4;cursor:pointer}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
    .note{color:#444;font-size:13px;margin-top:8px;word-break:break-all}
    code{background:#f2f2f2;padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Whatnot Lister v2</h1>

    <div class="card">
      <h2>1) Confirm server path</h2>
      <div class="note">This worker reads images directly from: <code>${base}</code></div>
      <div class="note">Example: <code>${base}/vinyl_lp/5000_1.jpg</code></div>
    </div>

    <div class="card">
      <h2>2) Build CSV</h2>
      <form method="POST" action="/process">
        <div class="row">
          <div>
            <label>Folder</label>
            <select name="folder" required>
              <option value="vinyl_lp">vinyl_lp (LP)</option>
              <option value="vinyl_45">vinyl_45 (45)</option>
              <option value="cd">cd</option>
              <option value="cassette">cassette</option>
            </select>
          </div>
          <div>
            <label>Start ID</label>
            <input name="startId" inputmode="numeric" placeholder="5000" required />
          </div>
        </div>
        <label>End ID</label>
        <input name="endId" inputmode="numeric" placeholder="5099" required />

        <div style="margin-top:12px;">
          <button type="submit">Process Images → Download CSV</button>
        </div>
        <div class="note">It scans IDs and includes only ones where <code>_1.jpg</code> exists.</div>
      </form>
    </div>

  </div>
</body>
</html>`;
}

function text(msg, status = 200) {
  return new Response(msg, { status, headers: { "content-type": "text/plain; charset=UTF-8" } });
}

async function headOk(u) {
  try {
    const r = await fetch(u, { method: "HEAD" });
    return r.ok;
  } catch {
    return false;
  }
}

async function headScan(ids, concurrency, urlForId) {
  const out = [];
  let i = 0;

  async function worker() {
    while (i < ids.length) {
      const id = ids[i++];
      const u = urlForId(id);
      const ok = await headOk(u);
      if (ok) out.push(id);
    }
  }

  const n = Math.max(1, Math.min(concurrency, 16));
  await Promise.all(Array.from({ length: n }, worker));
  out.sort((a, b) => a - b);
  return out;
}

function toImageCols(urls) {
  const out = {};
  for (let i = 0; i < 8; i++) out[`Image URL ${i + 1}`] = urls[i] || "";
  return out;
}

function noEmoji(s) {
  return (s || "").replace(/[\p{Extended_Pictographic}]/gu, "").trim();
}

function clamp50(s) {
  s = (s || "").trim();
  return s.length > 50 ? s.slice(0, 50).trim() : s;
}

function clampDesc(s) {
  s = (s || "").trim();
  return s.length > 500 ? s.slice(0, 500).trim() : s;
}

function escCsv(v) {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers, rows) {
  const lines = [];
  lines.push(headers.map(escCsv).join(","));
  for (const r of rows) lines.push(headers.map((h) => escCsv(r[h] ?? "")).join(","));
  return lines.join("\n");
}

async function readMusicFromImage(env, imageUrl) {
  if (!imageUrl) return { artist: "Unknown", title: "Unknown" };

  const model = env.OPENAI_MODEL || "gpt-4o-mini";
  const prompt =
    "Extract listing basics from a photo of music media packaging. " +
    "Return JSON only with keys: artist, title. " +
    "If unsure, best guess. Short, clean, no emojis.";

  const body = {
    model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: imageUrl },
        ],
      },
    ],
  };

  try {
    const resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) return { artist: "Unknown", title: "Unknown" };

    const data = await resp.json();
    const text = (data.output_text || "").trim();

    const j = JSON.parse(text);
    return {
      artist: (j.artist || "Unknown").toString().trim(),
      title: (j.title || "Unknown").toString().trim(),
    };
  } catch {
    return { artist: "Unknown", title: "Unknown" };
  }
}
