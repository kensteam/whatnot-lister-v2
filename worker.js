export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Home UI (NO upload button)
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(htmlPage(env), {
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }

    // Build CSV
    if (request.method === "POST" && url.pathname === "/process") {
      assertEnv(env);

      const TYPE_RULES = {
        vinyl_lp: { category: "Music", subcategory: "Vinyl Records", price: 5, shipping: "1 lb", label: "LP vinyl record" },
        vinyl_45: { category: "Music", subcategory: "Vinyl Records", price: 3, shipping: "4-7 oz", label: "45 rpm vinyl record" },
        cd: { category: "Music", subcategory: "CDs & Cassettes", price: 3, shipping: "4-7 oz", label: "CD" },
        cassette: { category: "Music", subcategory: "CDs & Cassettes", price: 3, shipping: "4-7 oz", label: "Music Cassette tape" },
      };

      const DEFAULTS = {
        quantity: 1,
        type: "Auction",
        offerable: "TRUE",
        hazmat: "Not Hazmat",
        condition: "", // you fill
        costPerItem: "",
      };

      const imgKeys = await listImageKeys(env.R2);

      // Group images by folder + baseId (5000_1.jpg => baseId=5000)
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

      const sortedItems = Array.from(items.values()).sort(
        (a, b) => a.baseId.localeCompare(b.baseId) || a.folder.localeCompare(b.folder)
      );

      const rows = [];
      const processedKeys = [];

      for (const item of sortedItems) {
        item.images.sort((a, b) => a.seq - b.seq);

        const rule = TYPE_RULES[item.folder];
        const imageUrls = item.images.slice(0, 8).map((x) => joinUrl(env.PUBLIC_BASE_URL, x.key));

        // AI reads ONLY the first image for artist/title
        const ai = await readMusicFromImage(env, imageUrls[0]);

        const titleRaw = `${ai.artist} ${ai.title} ${rule.label}`.trim();
        const title = clamp50(noEmoji(titleRaw)) || clamp50(`${rule.label} ${item.baseId}`);

        const description = clampDesc(
          `${ai.artist} - ${ai.title}. See photos. Ships fast.`
        );

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
          SKU: `${item.baseId}`,
          ...toImageCols(imageUrls),
        });

        for (const img of item.images) processedKeys.push(img.key);
      }

      // Save “what we processed” so Cleanup can delete those images later
      await env.R2.put("_processed/last.json", JSON.stringify({ keys: processedKeys }), {
        httpMetadata: { contentType: "application/json" },
      });

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

    // Cleanup after CSV upload to Whatnot
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

// ---------- UI ----------
function htmlPage(env) {
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
    button{font-size:18px;padding:14px 18px;border-radius:12px;border:1px solid #ddd;background:#f4f4f4;cursor:pointer}
    .note{color:#444;font-size:13px;margin-top:8px}
    code{background:#f6f6f6;padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Whatnot Lister v2</h1>

    <div class="card">
      <h2>1) Put images into R2</h2>
      <div class="note">
        Expected keys like:<br/>
        <code>vinyl_lp/5000_1.jpg</code><br/>
        <code>vinyl_45/8000_1.jpg</code><br/>
        <code>cd/6000_1.jpg</code><br/>
        <code>cassette/7000_1.jpg</code>
      </div>
    </div>

    <div class="card">
      <h2>2) Process → Download CSV</h2>
      <form method="POST" action="/process">
        <button type="submit">Process Images</button>
      </form>
      <div class="note">Downloads <code>whatnot_upload.csv</code>.</div>
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

// ---------- Guards ----------
function assertEnv(env) {
  if (!env.R2) throw new Error("Missing R2 binding named 'R2'.");
  if (!env.PUBLIC_BASE_URL) throw new Error("Missing PUBLIC_BASE_URL variable.");
  if (!env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY secret.");
}

// ---------- R2 helpers ----------
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

// ---------- CSV ----------
function escCsv(v) {
  const s = (v === null || v === undefined) ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers, rows) {
  const lines = [];
  lines.push(headers.map(escCsv).join(","));
  for (const r of rows) lines.push(headers.map((h) => escCsv(r[h] ?? "")).join(","));
  return lines.join("\n");
}

// ---------- text cleanup ----------
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

// ---------- AI (FIXED parsing + default model) ----------
async function readMusicFromImage(env, imageUrl) {
  const model = (env.OPENAI_MODEL || "gpt-4o-mini").trim();

  const prompt = `Extract listing basics from a photo of music media packaging.
Return JSON ONLY with keys: artist, title.
If unsure, best guess. Keep short. No emojis.`;

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

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    return { artist: "Unknown", title: "Unknown" };
  }

  const data = await resp.json();

  // Robust extraction of model text
  let text = "";
  for (const out of (data.output || [])) {
    if (out.type !== "message") continue;
    for (const c of (out.content || [])) {
      if (c.type === "output_text" && c.text) text += c.text;
    }
  }
  text = (text || "").trim();

  try {
    const j = JSON.parse(text);
    return {
      artist: (j.artist || "Unknown").toString().trim(),
      title: (j.title || "Unknown").toString().trim(),
    };
  } catch {
    return { artist: "Unknown", title: "Unknown" };
  }
}
