export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const debug = env.DEBUG === "true" || url.searchParams.get("debug") === "1";

    // ── GET / ── HTML UI ──────────────────────────────────────────────────
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(htmlPage(env), {
        headers: { "content-type": "text/html; charset=UTF-8" },
      });
    }

    // ── GET /debug-one?id=5000&folder=vinyl_lp ── single-item diagnostic ─
    if (request.method === "GET" && url.pathname === "/debug-one") {
      try { assertEnv(env); } catch (e) {
        return jsonResp({ error: e.message }, 500);
      }

      const folder = url.searchParams.get("folder") || "vinyl_lp";
      const id = Number(url.searchParams.get("id"));
      if (!Number.isFinite(id) || id <= 0) {
        return jsonResp({ error: "Pass ?id=<number> (positive integer)" }, 400);
      }

      const TYPE_RULES = typeRules();
      const rule = TYPE_RULES[folder];
      if (!rule) {
        return jsonResp({ error: `Unknown folder "${folder}". Use: ${Object.keys(TYPE_RULES).join(", ")}` }, 400);
      }

      // 1. Resolve images — same logic as /process
      const imageUrls = [];
      const missingVariants = [];
      for (let seq = 1; seq <= 8; seq++) {
        const found = await findImageUrl(env.IMAGE_BASE_URL, folder, id, seq);
        if (found) {
          imageUrls.push(found);
        } else {
          missingVariants.push(`${id}_${seq} — no variant found`);
          break;
        }
      }

      if (imageUrls.length === 0) {
        return jsonResp({
          id,
          folder,
          image_urls: [],
          openai_status: null,
          openai_error: "No images found for this ID — nothing to send to OpenAI",
          openai_raw_preview: null,
          parsed_object: null,
          final_title: "",
          final_description: "",
          warnings: [`No image variants exist for ${folder}/${id}_1`],
          missing_variants: missingVariants,
        });
      }

      // 2. Call OpenAI — same function as /process
      const ai = await callOpenAIForListing(env, imageUrls, { folder, label: rule.label, id });

      // 3. Build final title/description — same logic as /process
      const { title: finalTitle, description: finalDescription } = buildTitleDesc(ai, rule, id);

      return jsonResp({
        id,
        folder,
        image_urls: imageUrls,
        model_used: ai._debug?.model_used ?? null,
        model_attempts: ai._debug?.model_attempts ?? [],
        openai_status: ai._debug?.status ?? null,
        openai_error: ai._debug?.error ?? null,
        openai_raw_preview: ai._debug?.rawPreview ?? null,
        parsed_object: ai._debug?.parsedObject ?? null,
        final_title: finalTitle,
        final_description: finalDescription,
        warnings: ai.warnings || [],
        missing_variants: missingVariants,
        openai_request_body_preview: ai._debug?.requestBodyPreview ?? null,
      });
    }

    // ── POST /process ── bulk CSV ─────────────────────────────────────────
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

      const rule = typeRules()[folder];
      const rows = [];
      const debugLogs = [];

      for (let id = startId; id <= endId; id++) {
        const idDebug = { id, images: [], missingVariants: [], openai: {} };

        // Gather images
        const imageUrls = [];
        for (let seq = 1; seq <= 8; seq++) {
          const found = await findImageUrl(env.IMAGE_BASE_URL, folder, id, seq);
          if (found) {
            imageUrls.push(found);
            idDebug.images.push(found);
          } else {
            idDebug.missingVariants.push(`${id}_${seq} — not found`);
            break;
          }
        }

        if (imageUrls.length === 0) {
          idDebug.missingVariants.push(`${id}_1 — no variant found (.jpg/.JPG/.JPEG/.jpeg)`);
          if (debug) debugLogs.push(idDebug);
          continue;
        }

        // AI call
        const ai = await callOpenAIForListing(env, imageUrls, { folder, label: rule.label, id });

        idDebug.openai = {
          status: ai._debug?.status,
          error: ai._debug?.error,
          rawPreview: ai._debug?.rawPreview,
          warnings: ai.warnings,
        };
        if (debug) debugLogs.push(idDebug);

        // Build final title/description with fallback
        const { title, description } = buildTitleDesc(ai, rule, id);

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

      // DEBUG → JSON
      if (debug) {
        return jsonResp({ rowCount: rows.length, debugLogs, rows });
      }

      // Normal → CSV
      const csvHeaders = [
        "Category", "Sub Category", "Title", "Description", "Quantity", "Type", "Price", "Shipping Profile",
        "Offerable", "Hazmat", "Condition", "Cost Per Item", "SKU",
        "Image URL 1", "Image URL 2", "Image URL 3", "Image URL 4", "Image URL 5", "Image URL 6", "Image URL 7", "Image URL 8",
      ];
      const csv = toCsv(csvHeaders, rows);

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
// TYPE_RULES (shared between routes)
// ──────────────────────────────────────────────────────────────────────────────

function typeRules() {
  return {
    vinyl_lp:  { category: "Music", subcategory: "Vinyl Records",   price: 5, shipping: "1 lb",   label: "LP vinyl record" },
    vinyl_45:  { category: "Music", subcategory: "Vinyl Records",   price: 3, shipping: "4-7 oz", label: "45 rpm vinyl record" },
    cd:        { category: "Music", subcategory: "CDs & Cassettes", price: 3, shipping: "4-7 oz", label: "CD" },
    cassette:  { category: "Music", subcategory: "CDs & Cassettes", price: 3, shipping: "4-7 oz", label: "Music cassette tape" },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Build title + description from AI result (shared logic, with fallback)
// ──────────────────────────────────────────────────────────────────────────────

function buildTitleDesc(ai, rule, id) {
  const artist = safeStr(ai.artist);
  const album  = safeStr(ai.album);
  const label  = safeStr(ai.label);
  const catNum = safeStr(ai.catalogNumber);

  // ── TITLE (deterministic, code-only — never trust model title) ──
  let title = "";
  if (artist && album) {
    title = `${artist} - ${album} LP`;
  } else if (artist) {
    title = `${artist} Vinyl LP`;
  } else {
    title = `Vinyl LP Lot ${id}`;
  }
  title = clamp50(noEmoji(title));

  // ── DESCRIPTION (deterministic template — never trust model description) ──
  const lines = [];

  if (artist && album) {
    lines.push(`LP Vinyl Record: ${artist} - ${album}`);
  } else {
    lines.push("LP Vinyl Record (see photos)");
  }

  const labelCat = [label, catNum].filter(Boolean).join(" ").trim();
  if (labelCat) {
    lines.push(`Label/Cat#: ${labelCat}`);
  }

  lines.push("Condition unknown; see photos.");
  lines.push("Ships fast & packed safely.");

  const description = clampDesc(noEmoji(lines.join("\n")));

  return { title, description };
}

// ──────────────────────────────────────────────────────────────────────────────
// HTML UI
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
          <button type="submit">Process Images &rarr; Download CSV</button>
        </div>
        <div class="note">Scans IDs and includes only ones where <code>_1.jpg</code> exists.</div>
      </form>
    </div>

    <div class="card">
      <h2>3) Debug single item</h2>
      <div class="note">
        <code>GET /debug-one?folder=vinyl_lp&amp;id=5000</code> &mdash;
        returns raw OpenAI response, resolved image URLs, parsed object, and final title/description.
      </div>
    </div>

  </div>
</body>
</html>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function assertEnv(env) {
  if (!env.IMAGE_BASE_URL) throw new Error("Missing IMAGE_BASE_URL.");
  if (!env.OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY secret.");
}

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "").replace(/^\/+/, "");
  return `${b}/${p}`;
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Image existence (Range GET + extension fallback)
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
// callOpenAIForListing — THE core AI function, used by both /process & /debug-one
// ──────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} env
 * @param {string[]} images  - full public image URLs
 * @param {{ folder: string, label: string, id: number }} hints
 * @returns {Promise<{
 *   title: string, description: string,
 *   artist: string, album: string, label: string, catalogNumber: string,
 *   confidence?: number, warnings: string[],
 *   _debug: { status?: number, error?: string, rawPreview?: string,
 *             parsedObject?: object, requestBodyPreview?: string }
 * }>}
 */
async function callOpenAIForListing(env, images, hints) {
  const primaryModel  = env.MODEL_PRIMARY  || "gpt-4.1-mini";
  const fallbackModel = env.MODEL_FALLBACK || "gpt-4o";
  const warnings = [];
  const _debug = {
    status: null, error: null, rawPreview: null, parsedObject: null,
    requestBodyPreview: null, model_used: null, model_attempts: [],
  };

  const systemPrompt = [
    `You are identifying an ${hints.label} from photos for an auction listing.`,
    `Return ONLY valid JSON (no markdown, no extra text).`,
    `Rules:`,
    `- If Artist + Album visible: identify both.`,
    `- If unsure: use best guess and keep it short.`,
    `- No emojis.`,
    `- Keep everything concise and auction-ready.`,
    `Schema:`,
    `{`,
    `  "artist": "string",`,
    `  "album": "string",`,
    `  "label": "string",`,
    `  "catalogNumber": "string",`,
    `  "confidence": number`,
    `}`,
  ].join("\n");

  // ── Build Responses API input payload (model inserted per attempt) ──
  // image_url is a bare string (confirmed working with /v1/responses)
  const contentItems = [
    { type: "input_text", text: systemPrompt },
  ];
  for (const imgUrl of images) {
    contentItems.push({
      type: "input_image",
      image_url: imgUrl,
    });
  }

  // ── Try primary model, fallback on 403 model_not_found ──
  const modelsToTry = [primaryModel, fallbackModel];
  let resp = null;
  let rawText = "";

  for (const model of modelsToTry) {
    const requestBody = {
      model,
      input: [
        { role: "user", content: contentItems },
      ],
    };

    // Stash request preview on first attempt
    if (_debug.model_attempts.length === 0) {
      try {
        _debug.requestBodyPreview = JSON.stringify(requestBody).slice(0, 1200);
      } catch { /* ignore */ }
    }

    const attempt = { model, status: null, error: null };
    _debug.model_attempts.push(attempt);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 30000);

    try {
      resp = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(requestBody),
        signal: ac.signal,
      });
      attempt.status = resp.status;
      rawText = await resp.text();
    } catch (err) {
      attempt.status = 0;
      attempt.error = `Fetch failed: ${err.message || String(err)}`;
      warnings.push(`[${model}] ${attempt.error}`);
      clearTimeout(timer);
      // If fetch itself failed, try next model
      resp = null;
      rawText = "";
      continue;
    } finally {
      clearTimeout(timer);
    }

    // ── Check for 403 model_not_found → retry with fallback ──
    if (resp.status === 403) {
      const is403ModelNotFound =
        rawText.includes("model_not_found") ||
        rawText.includes("does not have access");
      if (is403ModelNotFound && model !== fallbackModel) {
        attempt.error = `403 model_not_found for ${model}, trying fallback`;
        warnings.push(attempt.error);
        resp = null;
        rawText = "";
        continue; // next model
      }
    }

    // Got a response (success or non-retryable error) — stop trying
    _debug.model_used = model;
    _debug.status = resp.status;
    _debug.rawPreview = rawText.slice(0, 1200);
    break;
  }

  // ── No response at all (both models failed at fetch level) ──
  if (!resp) {
    _debug.error = "All model attempts failed";
    warnings.push(_debug.error);
    return fallbackResult(warnings, _debug);
  }

  // ── Non-200 → surface the error, NEVER swallow ──
  if (!resp.ok) {
    _debug.error = `OpenAI HTTP ${resp.status}: ${rawText.slice(0, 600)}`;
    warnings.push(_debug.error);
    return fallbackResult(warnings, _debug);
  }

  // ── Parse the JSON envelope ──
  let data;
  try {
    data = JSON.parse(rawText);
  } catch (err) {
    _debug.error = `Response JSON parse error: ${err.message}`;
    warnings.push(_debug.error);
    return fallbackResult(warnings, _debug);
  }

  // ── Extract model text ──
  // Responses API: prefer data.output_text (top-level convenience field).
  // Fallback: traverse data.output[] → message → content[] → output_text or text block.
  let outputText = "";

  if (typeof data.output_text === "string" && data.output_text.trim()) {
    outputText = data.output_text.trim();
  } else if (Array.isArray(data.output)) {
    outer:
    for (const item of data.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const block of item.content) {
          if (block.type === "output_text" && typeof block.text === "string") {
            outputText = block.text.trim();
            break outer;
          }
          if (block.type === "text" && typeof block.text === "string") {
            outputText = block.text.trim();
            break outer;
          }
        }
      }
    }
  }

  if (!outputText) {
    _debug.error = "No output_text found in OpenAI response. Top-level keys: " + Object.keys(data).join(", ");
    warnings.push(_debug.error);
    return fallbackResult(warnings, _debug);
  }

  // Strip markdown fences if the model wrapped them
  outputText = outputText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // ── Parse the model's JSON ──
  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch (err) {
    _debug.error = `Model JSON parse failed: ${err.message}`;
    warnings.push(`JSON parse failed. Raw output: ${outputText.slice(0, 400)}`);
    return fallbackResult(warnings, _debug);
  }

  _debug.parsedObject = parsed;

  return {
    artist:        safeStr(parsed.artist)         || "",
    album:         safeStr(parsed.album)          || "",
    label:         safeStr(parsed.label)          || "",
    catalogNumber: safeStr(parsed.catalogNumber)  || "",
    confidence:    typeof parsed.confidence === "number" ? parsed.confidence : undefined,
    warnings,
    _debug,
  };
}

function fallbackResult(warnings, _debug) {
  return {
    artist: "",
    album: "",
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
