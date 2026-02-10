export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ---- REQUIRED BINDINGS ----
    // env.R2 -> R2 bucket binding name MUST be "R2"
    // env.PUBLIC_BASE_URL -> Worker variable (string), your r2.dev base url
    if (!env.R2) return new Response("Missing R2 binding named 'R2'.", { status: 500 });
    if (!env.PUBLIC_BASE_URL) return new Response("Missing Worker variable PUBLIC_BASE_URL.", { status: 500 });

    // ---- UI ----
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(htmlPage(), {
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }

    // ---- UPLOAD ----
    // POST /upload
    if (request.method === "POST" && url.pathname === "/upload") {
      const form = await request.formData();

      const mediaType = String(form.get("media_type") || "").trim();
      const itemId = String(form.get("item_id") || "").trim();

      if (!/^(vinyl_lp|vinyl_45|cd|cassette)$/.test(mediaType)) {
        return new Response("Bad media_type. Use vinyl_lp, vinyl_45, cd, cassette.", { status: 400 });
      }
      if (!/^\d{4,}$/.test(itemId)) {
        return new Response("Bad item_id. Use 4+ digits like 5000, 5001, 7000.", { status: 400 });
      }

      // Grab all file fields named "photos"
      const files = form.getAll("photos").filter(Boolean);
      if (!files.length) return new Response("No files uploaded.", { status: 400 });

      // Limit 2–8 like you want (still allow 1 if you insist, but enforce max)
      if (files.length > 8) return new Response("Too many photos. Max 8.", { status: 400 });

      const saved = [];

      let seq = 1;
      for (const f of files) {
        // f is a File
        const name = (f && f.name) ? f.name : "";
        const ext = safeExt(name) || guessExtFromType(f.type) || "jpg";
        const key = `${mediaType}/${itemId}_${seq}.${ext}`;

        const arrayBuf = await f.arrayBuffer();
        await env.R2.put(key, arrayBuf, {
          httpMetadata: { contentType: f.type || contentTypeForExt(ext) },
        });

        saved.push(key);
        seq++;
      }

      return new Response(
        JSON.stringify({ ok: true, saved, public: saved.map(k => joinUrl(env.PUBLIC_BASE_URL, k)) }, null, 2),
        { headers: { "content-type": "application/json; charset=UTF-8" } }
      );
    }

    // ---- PROCESS -> CSV DOWNLOAD ----
    // POST /process
    if (request.method === "POST" && url.pathname === "/process") {
      const TYPE_RULES = {
        vinyl_lp: { category: "Music", subcategory: "Vinyl Records", price: 5, shipping: "1 lb" },
        vinyl_45: { category: "Music", subcategory: "Vinyl Records", price: 3, shipping: "4-7 oz" },
        cd:       { category: "Music", subcategory: "CDs & Cassettes", price: 3, shipping: "4-7 oz" },
        cassette: { category: "Music", subcategory: "CDs & Cassettes", price: 3, shipping: "4-7 oz" },
      };

      const DEFAULTS = {
        quantity: 1,
        saleType: "Auction",
        offerable: "TRUE",
        hazmat: "Not Hazmat",
        condition: "", // you fill later
        costPerItem: "",
      };

      // List all objects in R2
      const allKeys = [];
      let cursor = undefined;
      do {
        const res = await env.R2.list({ cursor });
        cursor = res.truncated ? res.cursor : undefined;
        for (const obj of res.objects) allKeys.push(obj.key);
      } while (cursor);

      // Accept jpg/jpeg/png/webp/heic
      const imgKeys = allKeys.filter((k) =>
        /\.(jpe?g|png|webp|heic)$/i.test(k) && /\/\d+_\d+\./.test(k)
      );

      // Group by folder + baseId (type + item number)
      const items = new Map();

      for (const key of imgKeys) {
        const [folder, file] = key.split("/", 2);
        if (!folder || !file) continue;

        const m = file.match(/^(\d+)_([0-9]+)\.(.+)$/);
        if (!m) continue;

        const baseId = m[1];
        const seq = Number(m[2]);

        const type = TYPE_RULES[folder];
        if (!type) continue;

        const itemKey = `${folder}:${baseId}`;
        if (!items.has(itemKey)) items.set(itemKey, { folder, baseId, images: [] });
        items.get(itemKey).images.push({ key, seq });
      }

      const rows = [];
      const sorted = Array.from(items.values())
        .sort((a, b) => (a.baseId.localeCompare(b.baseId) || a.folder.localeCompare(b.folder)));

      for (const item of sorted) {
        item.images.sort((a, b) => a.seq - b.seq);

        const type = TYPE_RULES[item.folder];

        // Temporary safe title (you can replace later once AI reading is added)
        const title = makeSafeTitle(item.folder, item.baseId);

        const description = "See photos. Ships fast.";

        const imageUrls = item.images
          .slice(0, 8)
          .map((x) => joinUrl(env.PUBLIC_BASE_URL, x.key));

        rows.push({
          "Category": type.category,
          "Sub Category": type.subcategory,
          "Title": title,
          "Description": description,
          "Quantity": DEFAULTS.quantity,
          "Type": DEFAULTS.saleType,
          "Price": type.price,
          "Shipping Profile": type.shipping,
          "Offerable": DEFAULTS.offerable,
          "Hazmat": DEFAULTS.hazmat,
          "Condition": DEFAULTS.condition,
          "Cost Per Item": DEFAULTS.costPerItem,
          "SKU": `${item.baseId}`,
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

    return new Response("Not found", { status: 404 });
  },
};

function htmlPage() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Whatnot Lister v2</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:0;background:#fff;}
    .wrap{max-width:920px;margin:40px auto;padding:0 18px;}
    h1{font-size:40px;margin:0 0 18px;}
    .card{border:1px solid #e7e7e7;border-radius:16px;padding:18px;margin:14px 0;}
    label{display:block;font-size:14px;color:#333;margin:10px 0 6px;}
    input,select{width:100%;font-size:18px;padding:12px;border:1px solid #ddd;border-radius:12px;}
    button{font-size:20px;padding:14px 18px;border-radius:14px;border:1px solid #ddd;background:#f4f4f4;cursor:pointer;margin-top:14px;width:100%}
    .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
    .note{margin-top:10px;color:#444;font-size:13px}
    .small{font-size:12px;color:#666;margin-top:6px}
    code{background:#f6f6f6;padding:2px 6px;border-radius:8px}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Whatnot Lister v2</h1>

    <div class="card">
      <h2 style="margin:0 0 10px;font-size:22px;">1) Upload Photos</h2>
      <form method="POST" action="/upload" enctype="multipart/form-data">
        <div class="row">
          <div>
            <label>Type</label>
            <select name="media_type" required>
              <option value="vinyl_lp">vinyl_lp (LP)</option>
              <option value="vinyl_45">vinyl_45 (45)</option>
              <option value="cd">cd</option>
              <option value="cassette">cassette</option>
            </select>
          </div>
          <div>
            <label>Item # (example: 5000)</label>
            <input name="item_id" inputmode="numeric" pattern="\\d{4,}" placeholder="5000" required />
          </div>
        </div>

        <label>Photos (2–8)</label>
        <input name="photos" type="file" accept="image/*" multiple required />

        <button type="submit">Upload to R2</button>
        <div class="small">Saves as: <code>type/item_1.ext</code>, <code>type/item_2.ext</code>...</div>
      </form>
    </div>

    <div class="card">
      <h2 style="margin:0 0 10px;font-size:22px;">2) Build CSV</h2>
      <form method="POST" action="/process">
        <button type="submit">Process Images → Download CSV</button>
      </form>
      <div class="note">CSV includes Category/Subcategory/Price/Shipping + up to 8 image URLs. Condition stays blank.</div>
    </div>
  </div>
</body>
</html>`;
}

function makeSafeTitle(folder, baseId) {
  const label =
    folder === "vinyl_lp" ? "Vinyl LP" :
    folder === "vinyl_45" ? "Vinyl 45" :
    folder === "cd" ? "CD" :
    folder === "cassette" ? "Cassette" :
    "Item";
  const t = `${label} ${baseId}`;
  return t.length > 50 ? t.slice(0, 50) : t;
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

function escCsv(v) {
  const s = (v === null || v === undefined) ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers, rows) {
  const lines = [];
  lines.push(headers.map(escCsv).join(","));
  for (const r of rows) {
    lines.push(headers.map((h) => escCsv(r[h] ?? "")).join(","));
  }
  return lines.join("\n");
}

function safeExt(filename) {
  const m = String(filename).toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return "";
  const ext = m[1];
  if (["jpg","jpeg","png","webp","heic"].includes(ext)) return ext === "jpeg" ? "jpg" : ext;
  return "";
}

function guessExtFromType(mime) {
  const t = String(mime || "").toLowerCase();
  if (t.includes("jpeg")) return "jpg";
  if (t.includes("png")) return "png";
  if (t.includes("webp")) return "webp";
  if (t.includes("heic") || t.includes("heif")) return "heic";
  return "";
}

function contentTypeForExt(ext) {
  if (ext === "jpg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  if (ext === "heic") return "image/heic";
  return "application/octet-stream";
}
