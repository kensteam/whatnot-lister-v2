export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(htmlPage(env), {
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }

    if (request.method === "POST" && url.pathname === "/process") {
      assertEnv(env);

      const form = await request.formData();
      const folder = (form.get("folder") || "").toString().trim();
      const startId = Number((form.get("startId") || "").toString().trim());
      const endId = Number((form.get("endId") || "").toString().trim());

      const allowedFolders = new Set(["vinyl_lp", "vinyl_45", "cd", "cassette"]);
      if (!allowedFolders.has(folder)) return new Response("Bad folder.", { status: 400 });
      if (!Number.isFinite(startId) || !Number.isFinite(endId) || startId <= 0 || endId < startId) {
        return new Response("Bad ID range.", { status: 400 });
      }

      // locked pricing + shipping
      const TYPE_RULES = {
        vinyl_lp: { category: "Music", subcategory: "Vinyl Records", price: 5, shipping: "1 lb", label: "LP vinyl record" },
        vinyl_45: { category: "Music", subcategory: "Vinyl Records", price: 3, shipping: "4-7 oz", label: "45 rpm vinyl record" },
        cd: { category: "Music", subcategory: "CDs & Cassettes", price: 3, shipping: "4-7 oz", label: "CD" },
        cassette: { category: "Music", subcategory: "CDs & Cassettes", price: 3, shipping: "4-7 oz", label: "Music cassette tape" },
      };

      const rule = TYPE_RULES[folder];

      const rows = [];
      for (let id = startId; id <= endId; id++) {
        // Existence check: GET with Range instead of HEAD (many file servers block HEAD)
        const firstUrl = joinUrl(env.IMAGE_BASE_URL, `${folder}/${id}_1.jpg`);
        const exists = await existsFast(firstUrl);
        if (!exists) continue;

        // Gather up to 8 images: stop when a seq is missing
        const imageUrls = [];
        for (let seq = 1; seq <= 8; seq++) {
          const u = joinUrl(env.IMAGE_BASE_URL, `${folder}/${id}_${seq}.jpg`);
          if (await existsFast(u)) imageUrls.push(u);
          else break;
        }

        // AI pull (artist/title) from image 1
        const ai = await readMusicFromImage(env, imageUrls[0]);

        const title =
          clamp50(noEmoji(`${ai.artist} ${ai.title} ${rule.label}`.trim())) ||
          clamp50(noEmoji(`${rule.label} ${id}`));

        const description = clampDesc(noEmoji(`${ai.artist} - ${ai.title}. See photos. Ships fast.`));

        rows.push({
          Category: rule.category,
          "Sub Category": rule.subcategory,
          Title: title,
          Description: description,
          Quantity: 1,
          Type: "Auction",
          Price: rule.price,
          "Shipping Profile": rule.shipping,
          Offerable: "TRUE",
          Hazmat: "Not Hazmat",
          Condition: "",
          "Cost Per Item": "",
          SKU: `${id}`,
          ...toImageCols(imageUrls),
        });
      }

      const headers = [
        "Category", "Sub Category", "Title", "Description", "Quantity", "Type", "Price", "Shipping Profile",
        "Offerable", "Hazmat", "Condition", "Cost Per Item", "SKU",
        "Image URL 1", "Image URL 2", "Image URL 3", "Image URL 4", "Image URL 5", "Image URL 6", "Image URL 7", "Image URL 8",
      ];

      const csv = toCsv(headers, rows);

      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=UTF-8",
          "content-disposition": `attachment; filename="whatnot_upload.csv"`,
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

function htmlPage(env) {
  const base = (env && env.IMAGE_BASE_URL) ? String(env.IMAGE_BASE_URL) : "";
  const baseClean = base ? base.replace(/\/+$/, "") : "";
  const example = baseClean ? `${baseClean}/vinyl_lp/5000_1.jpg` : "SET IMAGE_BASE_URL";

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
    code{background:#f4f4f4;padding:2px 6px;border-radius:6px}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Whatnot Lister v2</h1>

    <div class="card">
      <h2>1) Confirm server path</h2>
      <div class="note">Worker reads directly from: <code>${escapeHtml(baseClean)}</code></div>
      <div class="note">Example: <code>${escapeHtml(example)}</code></div>
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
        <input name="endId" inputmode="numeric" placeholder="5004" required />

        <div style="margin-top:12px;">
          <button type="submit">Process Images → Download CSV</button>
        </div>
        <div class="note">Scans IDs and includes only ones where <code>_1.jpg</code> exists.</div>
      </form>
    </div>

  </div>
</body>
</html>`;
}

function assertEnv(env) {
  if (!env.IMAGE_BASE_URL) throw new Error("Missing IMAGE_BASE_URL.");
  if (!env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY secret.");
}

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "").replace(/^\/+/, "");
  return `${b}/${p}`;
}

// GET Range=0-0 avoids downloading full images AND works when HEAD is blocked.
async function existsFast(u) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 4000);
  try {
    const r = await fetch(u, {
      method: "GET",
      headers: { "Range": "bytes=0-0" },
      signal: ac.signal,
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
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
  for (const r of rows) lines.push(headers.map((h) => escCsv(r[h] ?? "")).join(","));
  return lines.join("\n");
}

async function readMusicFromImage(env, imageUrl) {
  const model = env.OPENAI_MODEL || "gpt-4o-mini";
  const prompt = `
Return JSON only: {"artist":"...","title":"..."}
You are looking at a photo of music media packaging/label.
Best guess if unsure. No emojis. Keep short.
`.trim();

  const body = {
    model,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: prompt },
        { type: "input_image", image_url: imageUrl },
      ],
    }],
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
console.log("OpenAI status:", resp.status);

const raw = await resp.text();
console.log("OpenAI raw response:", raw);

// then parse it
const data = JSON.parse(raw);  if (!resp.ok) return { artist: "Unknown", title: "Unknown" };

  const data = await resp.json();
  const text = (data.output_text || "").trim();
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

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
