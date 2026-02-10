export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Simple UI
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(htmlPage(), {
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }

    // Button hits this endpoint
    if (request.method === "POST" && url.pathname === "/process") {
      if (!env.R2) {
        return new Response("Missing R2 binding named 'R2'.", { status: 500 });
      }
      if (!env.PUBLIC_BASE_URL) {
        return new Response("Missing PUBLIC_BASE_URL Worker variable.", { status: 500 });
      }

      // ---- CONFIG (your locked rules) ----
      // Price rules (you said this 10 times):
      // LP = $5, CD/45/cassette = $3
      const TYPE_RULES = {
        vinyl_lp:   { category: "Music", subcategory: "Vinyl Records", price: 5, shipping: "1-2 lbs" },
        vinyl_45:   { category: "Music", subcategory: "Vinyl Records", price: 3, shipping: "4-7 oz" },
        cd:         { category: "Music", subcategory: "CDs & Cassettes", price: 3, shipping: "4-7 oz" },
        cassette:   { category: "Music", subcategory: "CDs & Cassettes", price: 3, shipping: "4-7 oz" },
      };

      // Whatnot required-ish defaults
      const DEFAULTS = {
        quantity: 1,
        saleType: "Buy It Now",
        offerable: "TRUE",
        hazmat: "Not Hazmat",
        condition: "",        // YOU fill later
        costPerItem: "",       // optional
      };

      // ---- READ OBJECTS FROM R2 ----
      // We accept keys like:
      // vinyl_lp/5000_1.jpg
      // cd/7000_3.jpg
      // cassette/8000_2.jpg
      const allKeys = [];
      let cursor = undefined;
      do {
        const res = await env.R2.list({ cursor });
        cursor = res.truncated ? res.cursor : undefined;
        for (const obj of res.objects) allKeys.push(obj.key);
      } while (cursor);

      const imgKeys = allKeys.filter((k) =>
        /\.(jpe?g|png|webp)$/i.test(k) && /\/\d+_\d+\./.test(k)
      );

      // Group into items by "####" (before underscore)
      // and infer type by folder name (prefix before first '/')
      const items = new Map();

      for (const key of imgKeys) {
        const [folder, file] = key.split("/", 2);
        if (!folder || !file) continue;

        const m = file.match(/^(\d+)_([0-9]+)\.(.+)$/);
        if (!m) continue;

        const baseId = m[1];         // 5000
        const seq = Number(m[2]);    // 1..n

        const type = TYPE_RULES[folder];
        if (!type) continue; // ignore unknown folders

        const itemKey = `${folder}:${baseId}`;
        if (!items.has(itemKey)) {
          items.set(itemKey, { folder, baseId, images: [] });
        }
        items.get(itemKey).images.push({ key, seq });
      }

      // Sort items and images
      const rows = [];
      const sorted = Array.from(items.values())
        .sort((a, b) => (a.baseId.localeCompare(b.baseId) || a.folder.localeCompare(b.folder)));

      for (const item of sorted) {
        item.images.sort((a, b) => a.seq - b.seq);

        const type = TYPE_RULES[item.folder];

        // Title must be <50 chars, no emojis
        // Keep it generic; you can edit later if you want.
        const title = makeSafeTitle(item.folder, item.baseId);

        const description = "See photos. Ships fast."; // safe placeholder

        const imageUrls = item.images
          .slice(0, 8) // Whatnot template shows multiple Image URL columns; we cap at 8
          .map((x) => joinUrl(env.PUBLIC_BASE_URL, x.key));

        rows.push({
          Category: type.category,
          "Sub Category": type.subcategory,
          Title: title,
          Description: description,
          Quantity: DEFAULTS.quantity,
          Type: DEFAULTS.saleType,
          Price: type.price,
          "Shipping Profile": type.shipping,
          Offerable: DEFAULTS.offerable,
          Hazmat: DEFAULTS.hazmat,
          Condition: DEFAULTS.condition,
          "Cost Per Item": DEFAULTS.costPerItem,
          SKU: `${item.baseId}`, // simple + stable
          ...toImageCols(imageUrls),
        });
      }

      // ---- OUTPUT CSV (Whatnot template columns) ----
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
    .wrap{max-width:860px;margin:60px auto;padding:0 20px;text-align:center;}
    h1{font-size:48px;margin:0 0 30px;}
    button{font-size:22px;padding:18px 28px;border-radius:14px;border:1px solid #ddd;background:#f4f4f4;cursor:pointer}
    button:active{transform:translateY(1px)}
    .note{margin-top:14px;color:#444;font-size:14px}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Whatnot Lister v2</h1>
    <form method="POST" action="/process">
      <button type="submit">Process Images</button>
    </form>
    <div class="note">Downloads a CSV built from your R2 bucket.</div>
  </div>
</body>
</html>`;
}

function makeSafeTitle(folder, baseId) {
  // under 50 chars, no emojis
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
