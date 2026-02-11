export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const debug = env.DEBUG === "true" || url.searchParams.get("debug") === "1";

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

      const TYPE_RULES = {
        vinyl_lp:  { category: "Music", subcategory: "Vinyl Records",     price: 5, shipping: "1 lb",   label: "LP vinyl record" },
        vinyl_45:  { category: "Music", subcategory: "Vinyl Records",     price: 3, shipping: "4-7 oz", label: "45 rpm vinyl record" },
        cd:        { category: "Music", subcategory: "CDs & Cassettes",   price: 3, shipping: "4-7 oz", label: "CD" },
        cassette:  { category: "Music", subcategory: "CDs & Cassettes",   price: 3, shipping: "4-7 oz", label: "Music cassette tape" },
      };

      const rule = TYPE_RULES[folder];
      const rows = [];
      const debugLogs = []; // Collect debug info per ID

      for (let id = startId; id <= endId; id++) {
        const idDebug = { id, images: [], missingVariants: [], openai: {} };

        // --- Check if primary image exists (try lowercase and uppercase extensions) ---
        const firstResult = await findImageUrl(env.IMAGE_BASE_URL, folder, id, 1);
        if (!firstResult) {
          idDebug.missingVariants.push(`${id}_1 — no variant found (.jpg/.JPG/.JPEG)`);
          if (debug) debugLogs.push(idDebug);
          continue;
        }

        // --- Gather up to 8 images, trying extension variants ---
        const imageUrls = [];
        for (let seq = 1; seq <= 8; seq++) {
          const found = await findImageUrl(env.IMAGE_BASE_URL, folder, id, seq);
          if (found) {
            imageUrls.push(found);
            idDebug.images.push(found);
          } else {
            idDebug.missingVariants.push(`${id}_${seq} — not found`);
            break; // stop at first gap
          }
        }

        // --- AI call ---
        const ai = await callOpenAIForListing(env, imageUrls, {
          folder,
          label: rule.label,
          id,
        });

        idDebug.openai = {
          status: ai._debug?.status,
          error: ai._debug?.error,
          rawPreview: ai._debug?.rawPreview,
          warnings: ai.warnings,
        };

        if (debug) debugLogs.push(idDebug);

        const artist = ai.artist || "Unknown";
        const album = ai.album || ai.title || "Unknown";

        const title =
          clamp50(noEmoji(`${artist} ${album} ${rule.label}`.trim())) ||
          clamp50(noEmoji(`${rule.label} ${id}`));

        const descParts = [
          ai.description || `${artist} - ${album}.`,
          ai.label ? `Label: ${ai.label}.` : "",
          ai.catalogNumber ? `Cat#: ${ai.catalogNumber}.` : "",
          "See photos. Ships fast.",
        ].filter(Boolean).join(" ");

        const description = clampDesc(noEmoji(descParts));

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

      // --- DEBUG mode: return JSON diagnostics instead of CSV ---
      if (debug) {
        return new Response(JSON.stringify({ rowCount: rows.length, debugLogs, rows }, null, 2), {
          headers: { "content-type": "application/json; charset=UTF-8" },
        });
      }

      // --- Normal mode: return CSV ---
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

// ──────────────────────────────────────────────────────────────────────────────
// HTML UI (unchanged except cosmetic)
// ──────────────────────────────────────────────────────────────────────────────

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
        <div class="note">Scans IDs and includes only ones where <code>_1.jpg</code> exists. Tip: add <code>?debug=1</code> to see diagnostics.</div>
      </form>
    </div>

  </div>
</body>
</html>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Environment assertion
// ──────────────────────────────────────────────────────────────────────────────

function assertEnv(env) {
  if (!env.IMAGE_BASE_URL) throw new Error("Missing IMAGE_BASE_URL.");
  if (!env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY secret.");
}

// ──────────────────────────────────────────────────────────────────────────────
// URL helpers
// ──────────────────────────────────────────────────────────────────────────────

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "").replace(/^\/+/, "");
  return `${b}/${p}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Image existence check (Range GET, with extension fallback)
// ──────────────────────────────────────────────────────────────────────────────

async function existsFast(u) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 4000);
  try {
    const r = await fetch(u, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
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

/**
 * Try .jpg, .JPG, .JPEG for a given id/seq.
 * Returns the first URL that exists, or null.
 */
async function findImageUrl(baseUrl, folder, id, seq) {
  const variants = [
    `${folder}/${id}_${seq}.jpg`,
    `${folder}/${id}_${seq}.JPG`,
    `${folder}/${id}_${seq}.JPEG`,
    `${folder}/${id}_${seq}.jpeg`,
  ];
  for (const v of variants) {
    const u = joinUrl(baseUrl, v);
    if (await existsFast(u)) return u;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Core AI function: callOpenAIForListing
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Calls the OpenAI Responses API with image URLs and returns structured listing data.
 *
 * @param {object} env  - Worker env (needs OPENAI_API_KEY, optional OPENAI_MODEL)
 * @param {string[]} images - Array of full public image URLs
 * @param {object} hints - { folder, label, id }
 * @returns {Promise<{
 *   title: string, description: string,
 *   artist?: string, album?: string, label?: string, catalogNumber?: string,
 *   confidence?: number, warnings?: string[],
 *   _debug?: { status: number, error?: string, rawPreview?: string }
 * }>}
 */
async function callOpenAIForListing(env, images, hints) {
  const model = env.OPENAI_MODEL || "gpt-4o-mini";
  const warnings = [];
  const _debug = {};

  const systemPrompt = `You are a music media identification expert. You will be shown photos of a ${hints.label}.
Respond with ONLY valid JSON, no markdown fences, no preamble, no trailing text.
Schema:
{
  "artist": "string",
  "album": "string",
  "title": "string (short listing title)",
  "description": "string (1-2 sentence selling description)",
  "label": "string or empty (record label if visible)",
  "catalogNumber": "string or empty",
  "confidence": 0.0-1.0
}
Best guess if unsure. No emojis. Keep artist/album short.`;

  // Build input content array: text instruction + all images
  const contentItems = [
    { type: "input_text", text: systemPrompt },
  ];
  for (const imgUrl of images) {
    contentItems.push({
      type: "input_image",
      image_url: imgUrl,
    });
  }

  const body = {
    model,
    input: [
      {
        role: "user",
        content: contentItems,
      },
    ],
  };

  // Timeout guard: 30 seconds
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);

  let resp;
  let rawText = "";
  try {
    resp = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    _debug.status = resp.status;
    rawText = await resp.text();
    _debug.rawPreview = rawText.slice(0, 1200);
  } catch (err) {
    _debug.status = 0;
    _debug.error = `Fetch error: ${err.message || err}`;
    warnings.push(_debug.error);
    return fallbackResult(hints, warnings, _debug);
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    _debug.error = `OpenAI HTTP ${resp.status}: ${rawText.slice(0, 500)}`;
    warnings.push(_debug.error);
    return fallbackResult(hints, warnings, _debug);
  }

  // Parse the response JSON envelope
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    _debug.error = `JSON envelope parse error: ${err.message}`;
    warnings.push(_debug.error);
    return fallbackResult(hints, warnings, _debug);
  }

  // --- Extract the model's text output ---
  // Responses API: prefer data.output_text (convenience field)
  // Fallback: traverse data.output[].content[] looking for type=output_text
  let outputText = "";

  if (typeof data.output_text === "string" && data.output_text.trim()) {
    outputText = data.output_text.trim();
  } else if (Array.isArray(data.output)) {
    for (const item of data.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (block.type === "output_text" && typeof block.text === "string") {
            outputText = block.text.trim();
            break;
          }
        }
      }
      if (outputText) break;
    }
  }

  if (!outputText) {
    _debug.error = "No output_text found in response";
    warnings.push(_debug.error);
    return fallbackResult(hints, warnings, _debug);
  }

  // Strip markdown fences if present
  outputText = outputText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // Parse the model's JSON
  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (err) {
    _debug.error = `Model JSON parse error: ${err.message}`;
    warnings.push(`Failed to parse model JSON. Raw: ${outputText.slice(0, 300)}`);
    return fallbackResult(hints, warnings, _debug);
  }

  return {
    title:         safeStr(parsed.title)         || safeStr(parsed.album) || "",
    description:   safeStr(parsed.description)   || "",
    artist:        safeStr(parsed.artist)         || "Unknown",
    album:         safeStr(parsed.album)          || "",
    label:         safeStr(parsed.label)          || "",
    catalogNumber: safeStr(parsed.catalogNumber)  || "",
    confidence:    typeof parsed.confidence === "number" ? parsed.confidence : undefined,
    warnings,
    _debug,
  };
}

function fallbackResult(hints, warnings, _debug) {
  return {
    title: "",
    description: "",
    artist: "Unknown",
    album: "Unknown",
    label: "",
    catalogNumber: "",
    confidence: 0,
    warnings,
    _debug,
  };
}

function safeStr(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

// ──────────────────────────────────────────────────────────────────────────────
// Whatnot field helpers
// ──────────────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────────────
// CSV helpers
// ──────────────────────────────────────────────────────────────────────────────

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

// ──────────────────────────────────────────────────────────────────────────────
// HTML escaping
// ──────────────────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
