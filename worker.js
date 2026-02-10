export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // UI
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(htmlPage(), {
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }

    // Process button
    if (request.method === "POST" && url.pathname === "/process") {
      if (!env.R2) return new Response("Missing R2 binding named 'R2'.", { status: 500 });
      if (!env.PUBLIC_BASE_URL) return new Response("Missing PUBLIC_BASE_URL.", { status: 500 });

      // OPTIONAL: limit scan to a folder/prefix like "Lister_Inbox/"
      const INBOX_PREFIX = (env.INBOX_PREFIX || "").trim(); // ex: "Lister_Inbox/"

      // Locked rules
      const DEFAULTS = {
        quantity: 1,
        saleType: "Buy It Now",
        offerable: "TRUE",
        hazmat: "Not Hazmat",
        condition: "",         // YOU fill later
        costPerItem: "",        // optional
        shippingProfile: "",    // YOU said you can pick it
      };

      // Determine media type by baseId range
      function typeFromBaseId(baseIdNum) {
        if (baseIdNum >= 5000 && baseIdNum <= 5999) {
          return { category: "Music", subcategory: "Vinyl Records", price: 5, label: "LP" };
        }
        if (baseIdNum >= 8000 && baseIdNum <= 8999) {
          return { category: "Music", subcategory: "Vinyl Records", price: 3, label: "45" };
        }
        if (baseIdNum >= 6000 && baseIdNum <= 6999) {
          return { category: "Music", subcategory: "CDs & Cassettes", price: 3, label: "CD" };
        }
        if (baseIdNum >= 7000 && baseIdNum <= 7999) {
          return { category: "Music", subcategory: "CDs & Cassettes", price: 3, label: "Cassette" };
        }
        return null;
      }

      // ---- READ OBJECTS FROM R2 (with optional prefix) ----
      const allKeys = [];
      let cursor = undefined;

      do {
        const res = await env.R2.list({
          cursor,
          prefix: INBOX_PREFIX || undefined,
        });
        cursor = res.truncated ? res.cursor : undefined;
        for (const obj of res.objects) allKeys.push(obj.key);
      } while (cursor);

      // Accept images anywhere, just needs filename like 5000_1.jpg
      const imgKeys = allKeys.filter((k) => /\.(jpe?g|png|webp)$/i.test(k));

      // Group by baseId (5000) regardless of folder
      const items = new Map();

      for (const key of imgKeys) {
        const filename = key.split("/").pop() || "";
        const m = filename.match(/^(\d{4})_([0-9]+)\.(jpe?g|png|webp)$/i);
        if (!m) continue;

        const baseId = m[1];
        const seq = Number(m[2]);
        const baseIdNum = Number(baseId);

        const type = typeFromBaseId(baseIdNum);
        if (!type) continue; // ignore anything outside your numbering ranges

        if (!items.has(baseId)) {
          items.set(baseId, { baseId, baseIdNum, type, images: [] });
        }
        items.get(baseId).images.push({ key, seq });
      }

      const rows = [];
      const sorted = Array.from(items.values()).sort((a, b) => a.baseIdNum - b.baseIdNum);

      for (const item of sorted) {
        item.images.sort((a, b) => a.seq - b.seq);

        // title placeholder (AI titles later)
        const title = makeSafeTitle(item.type.label, item.baseId);
        const description = "Condition shown live on stream."; // safe placeholder

        const imageUrls = item.images.slice(0, 8).map((x) => joinUrl(env.PUBLIC_BASE_URL, x.key));

        rows.push({
          Category: item.type.category,
          "Sub Category": item.type.subcategory,
          Title: title,
          Description: description,
          Quantity: DEFAULTS.quantity,
          Type: DEFAULTS.saleType,
          Price: item.type.price,
          "Shipping Profile": DEFAULTS.shippingProfile, // blank (you pick)
          Offerable: DEFAULTS.offerable,
          Hazmat: DEFAULTS.hazmat,
          Condition: DEFAULTS.condition, // blank (you fill)
          "Cost Per Item": DEFAULTS.costPerItem,
          SKU: `${item.baseId}`, // stable
          ...toImageCols(imageUrls),
        });
      }

      // If zero rows, return a loud message instead of an “empty file”
      if (rows.length === 0) {
        return new Response(
          `No matching images found.\n\nExpected filenames like 5000_1.jpg, 6000_1.jpg, 7000_1.jpg, 8000_1.jpg\nOptional prefix scanned: "${INBOX_PREFIX || "(none)"}"\nTotal objects seen: ${allKeys.length}`,
          { status: 400 }
        );
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

function makeSafeTitle(label, baseId) {
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
