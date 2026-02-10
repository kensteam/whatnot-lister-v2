export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // --- ROUTES ---
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(htmlPage(), { headers: { "content-type": "text/html; charset=UTF-8" } });
    }

    // Upload images from phone -> R2
    if (request.method === "POST" && url.pathname === "/upload") {
      assertEnv(env);

      const form = await request.formData();
      const folder = (form.get("folder") || "").toString().trim();
      const baseId = (form.get("baseId") || "").toString().trim();

      const allowedFolders = new Set(["vinyl_lp", "vinyl_45", "cd", "cassette"]);
      if (!allowedFolders.has(folder)) return new Response("Bad folder.", { status: 400 });
      if (!/^\d+$/.test(baseId)) return new Response("baseId must be digits (ex: 5000).", { status: 400 });

      const files = form.getAll("files");
      if (!files.length) return new Response("No files selected.", { status: 400 });

      // Store as folder/baseId_1.jpg, baseId_2.jpg, ...
      let seq = 1;
      const savedKeys = [];

      for (const f of files) {
        if (!(f instanceof File)) continue;

        // IMPORTANT: We are not converting HEIC here.
        // Keep phone camera set to JPG if possible.
        const ct = (f.type || "").toLowerCase();
        if (!ct.includes("jpeg") && !ct.includes("jpg") && !ct.includes("png") && !ct.includes("webp")) {
          return new Response(`Unsupported file type: ${f.type}. Use JPG/PNG/WebP.`, { status: 400 });
        }

        const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
        const key = `${folder}/${baseId}_${seq}.${ext}`;
        const buf = await f.arrayBuffer();

        await env.R2.put(key, buf, {
          httpMetadata: { contentType: f.type || "image/jpeg" },
        });

        savedKeys.push(key);
        seq += 1;
      }

      return new Response(
        `Uploaded:\n${savedKeys.join("\n")}\n\nNow hit Process.`,
        { headers: { "content-type": "text/plain; charset=UTF-8" } }
      );
    }

    // Process -> CSV download
    if (request.method === "POST" && url.pathname === "/process") {
      assertEnv(env);

      const TYPE_RULES = {
        vinyl_lp: { category: "Music", subcategory: "Vinyl Records", price: 5, shipping: "1 lb", label: "LP vinyl record" },
        vinyl_45: { category: "Music", subcategory: "Vinyl Records", price: 3, shipping: "4-7 oz", label: "45 rpm vinyl record" },
        cd:       { category: "Music", subcategory: "CDs & Cassettes", price: 3, shipping: "4-7 oz", label: "CD" },
        cassette: { category: "Music", subcategory: "CDs & Cassettes", price: 3, shipping: "4-7 oz", label: "Music Cassette tape" },
      };

      const DEFAULTS = {
        quantity: 1,
        type: "Auction",
        offerable: "TRUE",
        hazmat: "Not Hazmat",
        condition: "", // you fill later
        costPerItem: "",
      };

      // List objects in R2
      const imgKeys = await listImageKeys(env.R2);

      // Group by folder + baseId (folder/baseId_seq.ext)
      const items = new Map();

      for (const key of imgKeys) {
        const [folder, file] = key.split("/", 2);
        if (!TYPE_RULES[folder]) continue;

        const m = file.match(/^(\d+)_([0-9]+)\.(jpe?g|png|webp)$/i);
        if (!m) continue;

        const baseId = m[1];
        const seq = Number(m[2]);

        const itemKey = `${folder}:${baseId}`;
        if (!items.has(itemKey)) items.set(itemKey, { folder, baseId, images: [] });
        items.get(itemKey).images.push({ key, seq });
      }

      const sortedItems = Array.from(items.values()).sort((a, b) =>
        a.baseId.localeCompare(b.baseId) || a.folder.localeCompare(b.folder)
      );

      // Build rows
      const rows = [];
      const processedKeys = [];

      for (const item of sortedItems) {
        item.images.sort((a, b) => a.seq - b.seq);

        const rule = TYPE_RULES[item.folder];
        const imageUrls = item.images.slice(0, 8).map(x => joinUrl(env.PUBLIC_BASE_URL, x.key));

        // AI reads the first image (front/cover)
        const ai = await readMusicFromImage(env, imageUrls[0]);

        // Title rules: <50 chars, no emojis
        const title = clamp50(noEmoji(`${ai.artist} ${ai.title} ${rule.label}`.trim()));

        // Basic description (safe + fast)
        const description = clampDesc(`${ai.artist} - ${ai.title}. See photos. Ships fast.`);

        rows.push({
          Category: rule.category,
          "Sub Category": rule.subcategory,
          Title: title || clamp50(noEmoji(`${rule.label} ${item.baseId}`)),
          Description: description,
          Quantity: DEFAULTS.quantity,
          Type: DEFAULTS.type,
          Price: rule.price,
          "Shipping Profile": rule.shipping,
          Offerable: DEFAULTS.offerable,
          Hazmat: DEFAULTS.hazmat,
          Condition: DEFAULTS.condition,
          "Cost Per Item": DEFAULTS.costPerItem,
          SKU: `${item.baseId}`,
          ...toImageCols(imageUrls),
        });

        // remember keys for cleanup
        for (const img of item.images) processedKeys.push(img.key);
      }

      // Save processed manifest for cleanup
      await env.R2.put("_processed/last.json", JSON.stringify({ keys: processedKeys }), {
        httpMetadata: { contentType: "application/json" },
      });

      const headers = [
        "Category","Sub Category","Title","Description","Quantity","Type","Price",
        "Shipping Profile","Offerable","Hazmat","Condition","Cost Per Item","SKU",
        "Image URL 1","Image URL 2","Image URL 3","Image URL 4","Image URL 5","Image URL 6","Image URL 7","Image URL 8"
      ];

      const csv = toCsv(headers, rows);

      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=UTF-8",
          "content-disposition": `attachment; filename="whatnot_upload.csv"`,
        },
      });
    }

    // Cleanup after you upload CSV to Whatnot
    if (request.method === "POST" && url.pathname === "/cleanup") {
      assertEnv(env);

      const obj = await env.R2.get("_processed/last.json");
      if (!obj) return new Response("No last.json found. Run Process first.", { status: 400 });

      const data = JSON.parse(await obj.text());
      const keys = Array.isArray(data.keys) ? data.keys : [];

      for (const k of keys) await env.R2.delete(k);

      return new Response(`Deleted ${keys.length} images.`, {
        headers: { "content-type": "text/plain; charset=UTF-8" },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

// --- HTML UI ---
function htmlPage() {
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
    .note{color:#444;font-size:13px;margin-top:8px}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Whatnot Lister v2</h1>

    <div class="card">
      <h2>1) Upload Photos</h2>
      <form method="POST" action="/upload" enctype="multipart/form-data">
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
            <label>Base ID (ex: 5000)</label>
            <input name="baseId" inputmode="numeric" placeholder="5000" required />
          </div>
        </div>

        <label>Choose images (2–8 is ideal)</label>
        <input type="file" name="files" accept="image/*" multiple required />

        <div style="margin-top:12px;">
          <button type="submit">Upload to R2</button>
        </div>
        <div class="note">Use JPG/PNG/WebP. (No HEIC conversion here.)</div>
      </form>
    </div>

    <div class="card">
      <h2>2) Process → Download CSV</h2>
      <form method="POST" action="/process">
        <button type="submit">Process Images</button>
      </form>
      <div class="note">This will download whatnot_upload.csv.</div>
    </div>

    <div class="card">
      <h2>3) Cleanup (after you upload CSV)</h2>
      <form method="POST" action="/cleanup">
        <button type="submit">Delete Processed Images</button>
      </form>
    </div>

  </div>
</body>
</html>`;
}

// --- Helpers ---
function assertEnv(env) {
  if (!env.R2) throw new Error("Missing R2 binding named 'R2'.");
  if (!env.PUBLIC_BASE_URL) throw new Error("Missing PUBLIC_BASE_URL variable.");
  if (!env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY secret.");
}

async function listImageKeys(r2) {
  const keys = [];
  let cursor = undefined;
  do {
    const res = await r2.list({ cursor });
    cursor = res.truncated ? res.cursor : undefined;
    for (const obj of res.objects) {
      if (/\.(jpe?g|png|webp)$/i.test(obj.key)) keys.push(obj.key);
    }
  } while (cursor);
  return keys;
}

function joinUrl(base, key) {
  const b = base.replace(/\/+$/, "");
  const k = key.replace(/^\/+/, "");
  return `${b}/${k}`;
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
  const s = (v === null || v === undefined) ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers, rows) {
  const lines = [];
  lines.push(headers.map(escCsv).join(","));
  for (const r of rows) lines.push(headers.map(h => escCsv(r[h] ?? "")).join(","));
  return lines.join("\n");
}

// --- OpenAI vision (Responses API) ---
async function readMusicFromImage(env, imageUrl) {
  const model = env.OPENAI_MODEL || "gpt-5";

  const prompt = `
You are extracting listing basics from a photo of music media packaging.
Return JSON only with keys: artist, title.
Rules:
- If unsure, best guess.
- Keep artist/title short and clean (no emojis).
`;

  const body = {
    model,
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          { type: "input_image", image_url: imageUrl }
        ]
      }
    ]
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    // fallback
    return { artist: "Unknown", title: "Unknown" };
  }

  const data = await resp.json();
  const text = (data.output_text || "").trim();

  try {
    const j = JSON.parse(text);
    return {
      artist: (j.artist || "Unknown").toString().trim(),
      title: (j.title || "Unknown").toString().trim(),
    };
  } catch {
    // if model returns text, not json
    return { artist: "Unknown", title: "Unknown" };
  }
}
