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

    // ── GET /debug-one?id=5000&folder=vinyl_lp&quality=fast ─────────────
    if (request.method === "GET" && url.pathname === "/debug-one") {
      try { assertEnv(env); } catch (e) {
        return jsonResp({ error: e.message }, 500);
      }

      const folder = url.searchParams.get("folder") || "vinyl_lp";
      const quality = url.searchParams.get("quality") || "fast";
      const id = Number(url.searchParams.get("id"));
      if (!Number.isFinite(id) || id <= 0) {
        return jsonResp({ error: "Pass ?id=<number> (positive integer)" }, 400);
      }

      const TYPE_RULES = typeRules();
      const rule = TYPE_RULES[folder];
      if (!rule) {
        return jsonResp({ error: `Unknown folder "${folder}". Use: ${Object.keys(TYPE_RULES).join(", ")}` }, 400);
      }

      const imageUrls = [];
      const missingVariants = [];
      for (let seq = 1; seq <= 8; seq++) {
        const found = await findImageUrl(env.IMAGE_BASE_URL, folder, id, seq);
        if (found) {
          imageUrls.push(found);
        } else {
          missingVariants.push(`${id}_${seq} — no variant found`);
        }
      }

      if (imageUrls.length === 0) {
        return jsonResp({
          id, folder, image_urls: [],
          ai_status: null, ai_error: "No images found for this ID",
          ai_raw_preview: null, parsed_object: null,
          final_title: "", final_description: "",
          warnings: [`No image variants exist for ${folder}/${id}_1`],
          missing_variants: missingVariants,
        });
      }

      const { urls: aiImageUrls, cfWarnings } = transformImageUrls(imageUrls, env);
      const ai = await callAIWithRetry(env, aiImageUrls, { folder, label: rule.label, id }, quality);
      const allWarnings = [...(ai.warnings || []), ...cfWarnings];
      const { title: finalTitle, description: finalDescription } = buildTitleDesc(ai, rule, id, folder);

      return jsonResp({
        id, folder, quality,
        image_urls: imageUrls,
        image_urls_sent: aiImageUrls,
        model_used: ai._debug?.model_used ?? null,
        model_attempts: ai._debug?.model_attempts ?? [],
        ai_status: ai._debug?.status ?? null,
        ai_error: ai._debug?.error ?? null,
        ai_raw_preview: ai._debug?.rawPreview ?? null,
        parsed_object: ai._debug?.parsedObject ?? null,
        final_title: finalTitle,
        final_description: finalDescription,
        warnings: allWarnings,
        missing_variants: missingVariants,
        ai_request_body_preview: ai._debug?.requestBodyPreview ?? null,
      });
    }

    // ── POST /process ── bulk CSV ─────────────────────────────────────────
    if (request.method === "POST" && url.pathname === "/process") {
      assertEnv(env);

      const form = await request.formData();
      let folder = (form.get("folder") || "").toString().trim();
      const startId = Number((form.get("startId") || "").toString().trim());
      const endId = Number((form.get("endId") || "").toString().trim());
      const platform = (form.get("platform") || "whatnot").toString().trim().toLowerCase();
      const quality = (form.get("quality") || "fast").toString().trim().toLowerCase();

      const allowedFolders = new Set(Object.keys(typeRules()));
      if (!allowedFolders.has(folder)) return new Response("Bad folder.", { status: 400 });
      if (!Number.isFinite(startId) || !Number.isFinite(endId) || startId <= 0 || endId < startId) {
        return new Response("Bad ID range.", { status: 400 });
      }

      const rule = typeRules()[folder];
      const rows = [];
      const debugLogs = [];

      // ── Gather all items with their images first ──
      const items = [];
      for (let id = startId; id <= endId; id++) {
        const idDebug = { id, images: [], missingVariants: [], ai: {} };

        // Scan all 8 slots independently (don't stop at first gap)
        const imageUrls = [];
        for (let seq = 1; seq <= 8; seq++) {
          const found = await findImageUrl(env.IMAGE_BASE_URL, folder, id, seq);
          if (found) {
            imageUrls.push(found);
            idDebug.images.push(found);
          } else {
            idDebug.missingVariants.push(`${id}_${seq} — not found`);
          }
        }

        if (imageUrls.length === 0) {
          idDebug.missingVariants.push(`${id} — no images found`);
          if (debug) debugLogs.push(idDebug);
          continue;
        }

        const minImages = rule.minImages || 1;
        if (imageUrls.length < minImages) {
          idDebug.missingVariants.push(`${id} — only ${imageUrls.length} image(s), need ${minImages}`);
          if (debug) debugLogs.push(idDebug);
          continue;
        }

        items.push({ id, imageUrls, idDebug });
      }

      // ── Process AI calls in parallel batches of 4 ──
      const BATCH_SIZE = 4;
      for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (item) => {
            const { urls: aiImageUrls, cfWarnings } = transformImageUrls(item.imageUrls, env);
            const ai = await callAIWithRetry(env, aiImageUrls, { folder, label: rule.label, id: item.id }, quality);

            item.idDebug.ai = {
              status: ai._debug?.status,
              error: ai._debug?.error,
              rawPreview: ai._debug?.rawPreview,
              warnings: [...(ai.warnings || []), ...cfWarnings],
            };

            const { title, description } = buildTitleDesc(ai, rule, item.id, folder);
            return {
              _folder: folder,
              Category: rule.category,
              "Sub Category": folder === "dvd" ? resolveDvdSubCategory(ai) : rule.subcategory,
              Title: title,
              Description: description,
              Quantity: 1,
              Type: "Auction",
              Price: rule.price,
              "Shipping Profile": rule.shipping,
              Offerable: "TRUE",
              Hazmat: "Not Hazmat",
              Condition: rule.condition || "",
              "Cost Per Item": "",
              SKU: `${item.id}`,
              ...toImageCols(item.imageUrls),
            };
          })
        );

        for (let j = 0; j < results.length; j++) {
          if (debug) debugLogs.push(batch[j].idDebug);
          if (results[j].status === "fulfilled") {
            rows.push(results[j].value);
          } else {
            batch[j].idDebug.ai.error = results[j].reason?.message || "Unknown error";
          }
        }
      }

      // DEBUG → JSON
      if (debug) {
        return jsonResp({ rowCount: rows.length, debugLogs, rows, platform, quality });
      }

      // ── Build CSV based on platform ──
      let csv, csvFilename;

      if (platform === "hibid") {
        const hibidRows = rows.map((r, idx) => ({
          "Lot Number":                       idx + 1,
          "Sale Order":                       idx + 1,
          "Title":                            r.Title,
          "Description":                      r.Description,
          "Linked Group":                     "",
          "Quantity":                          1,
          "Presale Estimate Min Each":         "",
          "Presale Estimate Max Each":         "",
          "Reserve Each":                      "",
          "Start Bid Each":                    r.Price,
          "Seller Code":                       "",
          "Commission Code":                   "",
          "Seller Tax Formula Code":           "",
          "Buyer Premium Formula Code":        "",
          "Buyer Tax Formula Code":            "",
          "Buyer Lot Charge 1 Formula Code":   "",
          "Buyer Lot Charge 2 Formula Code":   "",
          "Clerk Status":                      "",
          "Hammer Price":                      "",
          "Bidder Number":                     "",
          "Quantity Sold":                     "",
          "Hibid Shipping Availability":       "Shipping Available",
          "Image URL":                         r["Image URL 1"] || "",
          "Lot Link URLs":                     "",
          "Lot Link Description":              "",
        }));
        const hibidHeaders = [
          "Lot Number", "Sale Order", "Title", "Description", "Linked Group", "Quantity",
          "Presale Estimate Min Each", "Presale Estimate Max Each", "Reserve Each", "Start Bid Each",
          "Seller Code", "Commission Code", "Seller Tax Formula Code", "Buyer Premium Formula Code",
          "Buyer Tax Formula Code", "Buyer Lot Charge 1 Formula Code", "Buyer Lot Charge 2 Formula Code",
          "Clerk Status", "Hammer Price", "Bidder Number", "Quantity Sold",
          "Hibid Shipping Availability", "Image URL", "Lot Link URLs", "Lot Link Description",
        ];
        csv = toCsv(hibidHeaders, hibidRows);
        csvFilename = `hibid_lots_${Date.now()}.csv`;

      } else if (platform === "ebay") {
        const EBAY_CATS = ebayCategories();
        const ebayRows = rows.map((r) => {
          const cat = EBAY_CATS[r._folder] || EBAY_CATS._default;
          const pics = [];
          for (let i = 1; i <= 8; i++) {
            const u = r[`Image URL ${i}`];
            if (u) pics.push(u);
          }
          return {
            "Action":                   "Add",
            "ItemID":                   "",
            "Title":                    r.Title,
            "Description":              r.Description,
            "Primary Category":         cat,
            "ConditionID":              3000,
            "Format":                   "Auction",
            "Duration":                 7,
            "Start Price":              r.Price,
            "Quantity":                 1,
            "Location":                 "Johnson City, TN",
            "DispatchTimeMax":          3,
            "ShippingService-1:Option": "USPSPriority",
            "ShippingService-1:Cost":   5.99,
            "ReturnsAcceptedOption":     "ReturnsNotAccepted",
            "ReturnsWithinOption":       "",
            "ShippingCostPaidByOption":  "",
            "SKU":                      r.SKU,
            "PictureURL":               pics.join("|"),
          };
        });
        const ebayHeaders = [
          "Action", "ItemID", "Title", "Description", "Primary Category", "ConditionID",
          "Format", "Duration", "Start Price", "Quantity", "Location", "DispatchTimeMax",
          "ShippingService-1:Option", "ShippingService-1:Cost", "ReturnsAcceptedOption",
          "ReturnsWithinOption", "ShippingCostPaidByOption", "SKU", "PictureURL",
        ];
        csv = toCsv(ebayHeaders, ebayRows);
        csvFilename = `ebay_upload_${Date.now()}.csv`;

      } else {
        const csvHeaders = [
          "Category", "Sub Category", "Title", "Description", "Quantity", "Type", "Price", "Shipping Profile",
          "Offerable", "Hazmat", "Condition", "Cost Per Item", "SKU",
          "Image URL 1", "Image URL 2", "Image URL 3", "Image URL 4", "Image URL 5", "Image URL 6", "Image URL 7", "Image URL 8",
        ];
        csv = toCsv(csvHeaders, rows);
        csvFilename = `whatnot_upload_${Date.now()}.csv`;
      }

      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=UTF-8",
          "content-disposition": `attachment; filename="${csvFilename}"`,
          "cache-control": "no-store, max-age=0",
          "pragma": "no-cache",
        },
      });
    }

    return new Response("Not found", { status: 404 });
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// TYPE_RULES
// ──────────────────────────────────────────────────────────────────────────────

function typeRules() {
  return {
    vinyl_lp:  { category: "Music",       subcategory: "Vinyl Records",    price: 5,  shipping: "1 lb",   label: "LP vinyl record",     minImages: 2 },
    vinyl_45:  { category: "Music",       subcategory: "Vinyl Records",    price: 3,  shipping: "4-7 oz", label: "45 rpm vinyl record", minImages: 2 },
    cd:        { category: "Music",       subcategory: "CDs & Cassettes",  price: 3,  shipping: "4-7 oz", label: "CD",                  minImages: 1 },
    cassette:  { category: "Music",       subcategory: "CDs & Cassettes",  price: 3,  shipping: "4-7 oz", label: "Music cassette tape", minImages: 1 },
    books:     { category: "Books",       subcategory: "New & Used Books", price: 5,  shipping: "",       label: "Book",                minImages: 2, condition: "Good" },
    dvd:       { category: "Movies & TV", subcategory: "DVD",              price: 3,  shipping: "4-7 oz", label: "DVD or Blu-ray disc", minImages: 2, condition: "Good" },
    magazines: { category: "Books",       subcategory: "",                  price: 5,  shipping: "",       label: "Magazine",            minImages: 2, condition: "Good" },
    general:   { category: "Collectibles", subcategory: "",                price: 5,  shipping: "",       label: "Item",                minImages: 2, condition: "Used" },
    coins:     { category: "Coins & Paper Money", subcategory: "Coins", price: 5,  shipping: "4-7 oz", label: "Coin",                minImages: 2, condition: "Used" },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// eBay category IDs
// ──────────────────────────────────────────────────────────────────────────────

function ebayCategories() {
  return {
    vinyl_lp:  176985,
    vinyl_45:  176985,
    cd:        176984,
    cassette:  176983,
    books:     261186,
    dvd:       617,
    magazines: 280,
    general:   1,
    coins:     253,
    _default:  1,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Build title + description from AI result
// ──────────────────────────────────────────────────────────────────────────────

function buildTitleDesc(ai, rule, id, folder) {
  if (folder === "books") return buildBookTitleDesc(ai, rule, id);
  if (folder === "dvd") return buildDvdTitleDesc(ai, rule, id);
  if (folder === "magazines") return buildMagazineTitleDesc(ai, rule, id);
  if (folder === "general") return buildGeneralTitleDesc(ai, rule, id);
  if (folder === "coins") return buildCoinTitleDesc(ai, rule, id);
  return buildVinylTitleDesc(ai, rule, id);
}

function buildVinylTitleDesc(ai, rule, id) {
  const artist = safeStr(ai.artist);
  const album  = safeStr(ai.album);
  const label  = safeStr(ai.label);
  const catNum = safeStr(ai.catalogNumber);

  let title = "";
  if (artist && album) title = `${artist} - ${album} LP`;
  else if (artist) title = `${artist} Vinyl LP`;
  else title = `Vinyl LP Lot ${id}`;
  title = clamp50(noEmoji(title));

  const lines = [];
  if (artist && album) lines.push(`LP Vinyl Record: ${artist} - ${album}`);
  else lines.push("LP Vinyl Record (see photos)");
  const labelCat = [label, catNum].filter(Boolean).join(" ").trim();
  if (labelCat) lines.push(`Label/Cat#: ${labelCat}`);
  lines.push("Condition unknown; see photos.");
  lines.push("Ships fast & packed safely in an LP mailer.");

  return { title, description: clampDesc(noEmoji(lines.join("\n"))) };
}

function buildBookTitleDesc(ai, rule, id) {
  const author = safeStr(ai.author);
  const bookTitle = safeStr(ai.title);
  const format = safeStr(ai.format);

  let title = "";
  if (author && bookTitle) {
    title = [author, bookTitle, format].filter(Boolean).join(" - ");
    if (title.length > 50 && format) title = `${author} - ${bookTitle}`;
    if (title.length > 50) title = bookTitle;
  } else if (bookTitle) {
    title = format ? `${bookTitle} - ${format}` : bookTitle;
  } else {
    title = `Book Lot ${id}`;
  }
  title = clamp50(noEmoji(title));

  const lines = [];
  if (author && bookTitle) lines.push(`${bookTitle} by ${author}.`);
  else if (bookTitle) lines.push(`${bookTitle}.`);
  else lines.push("Book (see photos).");
  if (format) lines.push(`Format: ${format}.`);
  lines.push("Condition: Good. See photos. Ships fast.");

  return { title, description: clampDesc(noEmoji(lines.join(" "))) };
}

function buildDvdTitleDesc(ai, rule, id) {
  const dvdTitle = safeStr(ai.title);
  const format = safeStr(ai.format);
  const year = safeStr(ai.year);
  const rating = safeStr(ai.rating);

  let title = "";
  if (dvdTitle) {
    title = [dvdTitle, format, year, rating].filter(Boolean).join(" - ");
    if (title.length > 50 && rating) title = [dvdTitle, format, year].filter(Boolean).join(" - ");
    if (title.length > 50 && year) title = [dvdTitle, format].filter(Boolean).join(" - ");
    if (title.length > 50) title = dvdTitle;
  } else {
    title = `DVD Lot ${id}`;
  }
  title = clamp50(noEmoji(title));

  const lines = [];
  if (dvdTitle) lines.push(`${dvdTitle} (${format || "DVD"}).`);
  else lines.push("DVD/Blu-ray disc (see photos).");
  if (year) lines.push(`Year: ${year}.`);
  if (rating) lines.push(`Rated: ${rating}.`);
  lines.push("Condition: Good. See photos. Ships fast.");

  return { title, description: clampDesc(noEmoji(lines.join(" "))) };
}

function resolveDvdSubCategory(ai) {
  const format = safeStr(ai.format).toLowerCase();
  if (format.includes("blu")) return "Blu-ray";
  if (format.includes("4k") || format.includes("uhd")) return "4K Ultra HD";
  return "DVD";
}

function buildMagazineTitleDesc(ai, rule, id) {
  const magTitle = safeStr(ai.title);
  const issueDate = safeStr(ai.issueDate);

  let title = "";
  if (magTitle && issueDate) {
    title = `${magTitle} - ${issueDate}`;
    if (title.length > 50) title = magTitle;
  } else if (magTitle) {
    title = magTitle;
  } else {
    title = `Magazine Lot ${id}`;
  }
  title = clamp50(noEmoji(title));

  const lines = [];
  if (magTitle) lines.push(`${magTitle} magazine.`);
  else lines.push("Magazine (see photos).");
  if (issueDate) lines.push(`Issue: ${issueDate}.`);
  lines.push("Condition: Good. See photos. Ships fast.");

  return { title, description: clampDesc(noEmoji(lines.join(" "))) };
}

function buildGeneralTitleDesc(ai, rule, id) {
  const itemTitle = safeStr(ai.title);
  const itemType = safeStr(ai.itemType);
  const brand = safeStr(ai.brand);
  const era = safeStr(ai.era);
  const material = safeStr(ai.material);
  const aiDesc = safeStr(ai.description);

  let title = "";
  if (itemTitle) title = itemTitle;
  else if (brand && itemType) title = `${brand} ${itemType}`;
  else if (itemType) title = itemType;
  else title = `Lot ${id}`;
  title = clamp50(noEmoji(title));

  const lines = [];
  if (aiDesc) {
    lines.push(aiDesc);
  } else {
    if (itemTitle) lines.push(`${itemTitle}.`);
    if (brand) lines.push(`Brand/Maker: ${brand}.`);
    if (material) lines.push(`Material: ${material}.`);
    if (era) lines.push(`Era: ${era}.`);
  }
  lines.push("Condition: Used. See photos for details. Ships fast.");

  return { title, description: clampDesc(noEmoji(lines.join(" "))) };
}

function buildCoinTitleDesc(ai, rule, id) {
  const coinTitle = safeStr(ai.title);
  const denomination = safeStr(ai.denomination);
  const year = safeStr(ai.year);
  const mintMark = safeStr(ai.mintMark);
  const coinType = safeStr(ai.coinType);
  const metal = safeStr(ai.metal);
  const country = safeStr(ai.country);

  let title = "";
  if (coinTitle) {
    title = coinTitle;
  } else {
    const parts = [year, country, denomination, coinType].filter(Boolean);
    title = parts.length ? parts.join(" ") : `Coin Lot ${id}`;
  }
  title = clamp50(noEmoji(title));

  const lines = [];
  if (year && denomination) lines.push(`${year} ${denomination}${coinType ? " " + coinType : ""}.`);
  else if (coinTitle) lines.push(`${coinTitle}.`);
  else lines.push("Coin (see photos).");
  if (mintMark) lines.push(`Mint mark: ${mintMark}.`);
  if (metal) lines.push(`Metal: ${metal}.`);
  if (country && country.toLowerCase() !== "usa" && country.toLowerCase() !== "us") lines.push(`Country: ${country}.`);
  lines.push("Condition: See photos. Ships fast in protective holder.");

  return { title, description: clampDesc(noEmoji(lines.join(" "))) };
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
  <title>Auction Lister</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0d10; --surface: #12151a; --surface2: #1a1e25;
      --border: #2a2f3a; --text: #e2e4e9; --text-dim: #6b7280;
      --green: #10b981; --green-dim: #059669; --green-glow: rgba(16,185,129,.12);
      --amber: #f59e0b; --amber-glow: rgba(245,158,11,.12);
      --radius: 10px;
    }
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'DM Sans',sans-serif; background:var(--bg); color:var(--text); min-height:100vh; }
    .wrap { max-width:720px; margin:0 auto; padding:32px 16px; }
    .header { display:flex; align-items:center; gap:12px; margin-bottom:28px; }
    .header-icon { width:44px; height:44px; background:var(--green-glow); border:1px solid rgba(16,185,129,.25); border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:22px; }
    h1 { font-family:'IBM Plex Mono',monospace; font-size:24px; font-weight:700; }
    h1 span { color:var(--green); }
    .card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:20px; margin:14px 0; }
    .card-title { font-family:'IBM Plex Mono',monospace; font-size:13px; font-weight:600; text-transform:uppercase; letter-spacing:1.5px; color:var(--green); margin-bottom:14px; }
    label { display:block; font-weight:600; font-size:13px; color:var(--text-dim); text-transform:uppercase; letter-spacing:.5px; margin:12px 0 6px; }
    input { width:100%; padding:12px 14px; border-radius:8px; border:1px solid var(--border); background:var(--surface2); color:var(--text); font-size:15px; font-family:'DM Sans',sans-serif; }
    input:focus { outline:none; border-color:var(--green); box-shadow:0 0 0 3px var(--green-glow); }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
    .row-3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; }
    .btn { width:100%; font-size:15px; font-weight:600; padding:14px 18px; border-radius:8px; border:none; background:var(--green); color:#fff; cursor:pointer; font-family:'DM Sans',sans-serif; transition:background .2s, transform .1s; margin-top:16px; }
    .btn:hover { background:var(--green-dim); }
    .btn:active { transform:scale(.98); }
    .note { color:var(--text-dim); font-size:12px; margin-top:10px; font-family:'IBM Plex Mono',monospace; }
    code { background:var(--surface2); padding:2px 6px; border-radius:4px; font-family:'IBM Plex Mono',monospace; font-size:12px; color:var(--green); }
    .footer { text-align:center; color:var(--text-dim); font-size:11px; font-family:'IBM Plex Mono',monospace; margin-top:32px; padding-top:16px; border-top:1px solid var(--border); }
    .type-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(120px,1fr)); gap:8px; margin-bottom:4px; }
    .type-chip { background:var(--surface2); border:1px solid var(--border); border-radius:8px; padding:10px 12px; text-align:center; cursor:pointer; transition:all .2s; font-size:13px; font-weight:500; }
    .type-chip:hover { border-color:var(--green); background:rgba(16,185,129,.06); }
    .type-chip.active { border-color:var(--green); background:var(--green-glow); color:var(--green); }
    .type-chip .chip-icon { font-size:20px; display:block; margin-bottom:4px; }
    .type-chip .chip-label { font-size:11px; color:var(--text-dim); }
    .type-chip.active .chip-label { color:var(--green); }
    .qual-chip { padding:8px 10px; font-size:12px; }
    .qual-chip .chip-icon { font-size:16px; }
    .qual-chip.active.quality { border-color:var(--amber); background:var(--amber-glow); color:var(--amber); }
    .qual-chip.active.quality .chip-label { color:var(--amber); }
    .divider { border-top:1px solid var(--border); margin:16px 0 8px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div class="header-icon">&#128722;</div>
      <h1>Auction <span>Lister</span></h1>
    </div>

    <div class="card">
      <div class="card-title">Server Path</div>
      <div class="note">Reading from: <code>${escapeHtml(baseClean)}</code></div>
      <div class="note">Example: <code>${escapeHtml(example)}</code></div>
    </div>

    <div class="card">
      <div class="card-title">Build CSV</div>
      <form method="POST" action="/process">
        <input type="hidden" name="folder" id="folderInput" value="vinyl_lp" />
        <input type="hidden" name="platform" id="platformInput" value="whatnot" />
        <input type="hidden" name="quality" id="qualityInput" value="fast" />

        <label>Item Type</label>
        <div class="type-grid">
          <div class="type-chip item-chip active" onclick="pickType(this,'vinyl_lp')"><span class="chip-icon">&#127926;</span>Vinyl LP<div class="chip-label">2 pics min</div></div>
          <div class="type-chip item-chip" onclick="pickType(this,'vinyl_45')"><span class="chip-icon">&#128191;</span>45 RPM<div class="chip-label">2 pics min</div></div>
          <div class="type-chip item-chip" onclick="pickType(this,'cd')"><span class="chip-icon">&#128191;</span>CD<div class="chip-label">1 pic min</div></div>
          <div class="type-chip item-chip" onclick="pickType(this,'cassette')"><span class="chip-icon">&#128252;</span>Cassette<div class="chip-label">1 pic min</div></div>
          <div class="type-chip item-chip" onclick="pickType(this,'books')"><span class="chip-icon">&#128214;</span>Books<div class="chip-label">2 pics min</div></div>
          <div class="type-chip item-chip" onclick="pickType(this,'dvd')"><span class="chip-icon">&#127916;</span>DVD<div class="chip-label">2 pics min</div></div>
          <div class="type-chip item-chip" onclick="pickType(this,'magazines')"><span class="chip-icon">&#128240;</span>Magazines<div class="chip-label">2 pics min</div></div>
          <div class="type-chip item-chip" onclick="pickType(this,'general')"><span class="chip-icon">&#128270;</span>General<div class="chip-label">Catch-all</div></div>
          <div class="type-chip item-chip" onclick="pickType(this,'coins')"><span class="chip-icon">&#129689;</span>Coins<div class="chip-label">2 pics min</div></div>
        </div>

        <div class="row">
          <div><label>Start ID</label><input name="startId" inputmode="numeric" placeholder="1" required /></div>
          <div><label>End ID</label><input name="endId" inputmode="numeric" placeholder="50" required /></div>
        </div>

        <div class="divider"></div>

        <label>Platform</label>
        <div class="row-3">
          <div class="type-chip platform-chip active" onclick="pickPlatform(this,'whatnot')"><span class="chip-icon">&#127918;</span>Whatnot<div class="chip-label">Auction CSV</div></div>
          <div class="type-chip platform-chip" onclick="pickPlatform(this,'hibid')"><span class="chip-icon">&#128296;</span>HiBid<div class="chip-label">Lots CSV</div></div>
          <div class="type-chip platform-chip" onclick="pickPlatform(this,'ebay')"><span class="chip-icon">&#128176;</span>eBay<div class="chip-label">File Exchange</div></div>
        </div>

        <label>AI Quality</label>
        <div class="row">
          <div class="type-chip qual-chip fast active" onclick="pickQuality(this,'fast')"><span class="chip-icon">&#9889;</span>Fast<div class="chip-label">Haiku &mdash; bulk runs</div></div>
          <div class="type-chip qual-chip quality" onclick="pickQuality(this,'quality')"><span class="chip-icon">&#127775;</span>Quality<div class="chip-label">Sonnet &mdash; better ID</div></div>
        </div>

        <button type="submit" class="btn">Process Images &rarr; Download CSV</button>
        <div class="note">General catch-all auto-identifies any item. Photos: name as <code>{id}_{seq}.jpg</code> (e.g. 1_1.jpg, 1_2.jpg). Upload to R2 folder matching item type.</div>
      </form>
    </div>

    <div class="card">
      <div class="card-title">Debug</div>
      <div class="note"><code>GET /debug-one?folder=general&amp;id=1&amp;quality=fast</code></div>
    </div>

    <div class="footer">Gooder Labs LLC &mdash; Auction Lister</div>
  </div>

  <script>
    function pickType(el, val) {
      document.querySelectorAll('.item-chip').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
      document.getElementById('folderInput').value = val;
    }
    function pickPlatform(el, val) {
      document.querySelectorAll('.platform-chip').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
      document.getElementById('platformInput').value = val;
    }
    function pickQuality(el, val) {
      document.querySelectorAll('.qual-chip').forEach(c => c.classList.remove('active'));
      el.classList.add('active');
      document.getElementById('qualityInput').value = val;
    }
  </script>
</body>
</html>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function resolveApiKey(env) {
  return env.ANTHROPIC_API_KEY || "";
}

function assertEnv(env) {
  if (!env.IMAGE_BASE_URL) throw new Error("Missing IMAGE_BASE_URL.");
  if (!resolveApiKey(env)) throw new Error("Missing ANTHROPIC_API_KEY secret.");
}

function resolveModel(quality) {
  if (quality === "quality") return "claude-sonnet-4-5-20250929";
  return "claude-haiku-4-5-20251001";
}

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  const p = String(path || "").replace(/^\/+/, "");
  return `${b}/${p}`;
}

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status, headers: { "content-type": "application/json; charset=UTF-8" },
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// Image existence
// ──────────────────────────────────────────────────────────────────────────────

async function existsFast(u) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 4000);
  try {
    const r = await fetch(u, { method: "GET", headers: { Range: "bytes=0-0" }, signal: ac.signal, cf: { cacheTtl: 0, cacheEverything: false } });
    return r.ok;
  } catch { return false; }
  finally { clearTimeout(t); }
}

async function findImageUrl(baseUrl, folder, id, seq) {
  const exts = ["jpg", "JPG", "JPEG", "jpeg", "png", "PNG"];
  for (const ext of exts) {
    const u = joinUrl(baseUrl, `${folder}/${id}_${seq}.${ext}`);
    if (await existsFast(u)) return u;
  }
  return null;
}

function transformImageUrls(urls, env) {
  if (env.IMAGE_CF !== "1") return { urls, cfWarnings: [] };
  const cfWarnings = [];
  const transformed = urls.map((u) => {
    try {
      const parsed = new URL(u);
      if (parsed.hostname.endsWith(".r2.dev")) { cfWarnings.push(`CF skip r2.dev: ${u}`); return u; }
      return `${parsed.origin}/cdn-cgi/image/width=1400,fit=contain,metadata=none${parsed.pathname}`;
    } catch { cfWarnings.push(`Bad URL: ${u}`); return u; }
  });
  return { urls: transformed, cfWarnings };
}

// ──────────────────────────────────────────────────────────────────────────────
// System prompts — production-grade, tells Claude exactly where to look
// ──────────────────────────────────────────────────────────────────────────────

function buildSystemPrompt(hints) {
  const { folder } = hints;

  if (folder === "vinyl_lp" || folder === "vinyl_45") {
    const size = folder === "vinyl_lp" ? "12-inch LP" : "7-inch 45 RPM single";
    return [
      `You are an expert vinyl record identifier examining photos of a ${size}.`,
      `Look at these areas in order:`,
      `1. CENTER LABEL: artist name, album/song title, record label name (Columbia, Atlantic, Capitol, etc.), catalog number (e.g. CL-1355, SD-8236).`,
      `2. COVER ART: artist name, album title printed on front.`,
      `3. BACK COVER: track listing, credits, label logo, catalog number, barcode.`,
      `4. SPINE: artist, title, label, catalog number in small print.`,
      `Return ONLY valid JSON. No markdown, no commentary. No emojis.`,
      `{"artist":"string","album":"string","label":"string","catalogNumber":"string","confidence":0-100}`,
    ].join("\n");
  }

  if (folder === "cd") {
    return [
      `You are identifying a CD from photos. Look at: front cover, spine text (artist - title - label), back cover tracklist, disc face.`,
      `Return ONLY valid JSON. No markdown. No emojis.`,
      `{"artist":"string","album":"string","label":"string","catalogNumber":"string","confidence":0-100}`,
    ].join("\n");
  }

  if (folder === "cassette") {
    return [
      `You are identifying a cassette tape. Look at: J-card insert front/spine/back, cassette shell label.`,
      `Return ONLY valid JSON. No markdown. No emojis.`,
      `{"artist":"string","album":"string","label":"string","catalogNumber":"string","confidence":0-100}`,
    ].join("\n");
  }

  if (folder === "books") {
    return [
      `You are identifying a book from photos. Examine:`,
      `1. FRONT COVER: title, author. 2. SPINE: author, title, publisher. 3. TITLE PAGE: full title, author, publisher, edition. 4. BACK: ISBN, publisher.`,
      `Determine binding: HC (hardcover) or PB (paperback).`,
      `Return ONLY valid JSON. No markdown. No emojis.`,
      `{"author":"string","title":"string","format":"HC or PB","confidence":0-100}`,
    ].join("\n");
  }

  if (folder === "dvd") {
    return [
      `You are identifying a DVD/Blu-ray/4K disc from photos. Examine:`,
      `1. FRONT: title, format badge (DVD/Blu-ray/4K Ultra HD logo). 2. SPINE: title, format. 3. BACK: rating (G/PG/PG-13/R/NR), year, studio. 4. DISC: format confirmation.`,
      `Format must be exactly: DVD, Blu-ray, or 4K UHD.`,
      `Return ONLY valid JSON. No markdown. No emojis.`,
      `{"title":"string","format":"DVD or Blu-ray or 4K UHD","year":"string","rating":"string","confidence":0-100}`,
    ].join("\n");
  }

  if (folder === "magazines") {
    return [
      `You are identifying a magazine from photos. Look at:`,
      `1. COVER: masthead (magazine name at top), cover date, issue number. 2. SPINE: name, date, volume. 3. MAILING LABEL if present.`,
      `Return ONLY valid JSON. No markdown. No emojis.`,
      `{"title":"string","issueDate":"string","confidence":0-100}`,
    ].join("\n");
  }

  if (folder === "coins") {
    return [
      `You are an expert numismatist identifying a coin from photos for an auction listing.`,
      `CRITICAL: Examine these areas very carefully, zooming into fine details:`,
      `1. OBVERSE (front face): Portrait or design, date/year (often below portrait or at bottom), motto text, denomination if shown.`,
      `2. REVERSE (back): Design, denomination (e.g. ONE CENT, QUARTER DOLLAR, ONE DIME), country name, mint mark.`,
      `3. MINT MARK: Tiny letter near the date or on reverse (D=Denver, S=San Francisco, P=Philadelphia, W=West Point, CC=Carson City, O=New Orleans). Look very carefully — mint marks are small.`,
      `4. EDGE: Reeded (ridged) or smooth — helps identify denomination. Any edge lettering.`,
      `5. METAL/COLOR: Gold, silver, copper, nickel-clad. Helps narrow denomination and era.`,
      `Identify the exact denomination (e.g. "Lincoln Wheat Cent", "Mercury Dime", "Walking Liberty Half Dollar", "Morgan Silver Dollar").`,
      `Return ONLY valid JSON. No markdown. No emojis.`,
      `{"title":"string (max 50 chars)","denomination":"string (e.g. One Cent, Quarter Dollar)","coinType":"string (e.g. Lincoln Wheat, Morgan, Walking Liberty)","year":"string","mintMark":"string (D/S/P/W/CC/O or empty)","metal":"string (copper, silver, gold, nickel-clad)","country":"string","confidence":0-100}`,
    ].join("\n");
  }

  // ── GENERAL catch-all ──
  return [
    `You are an expert item identifier for auction listings. Examine the photos and identify this item.`,
    `Determine: 1) What is it? (knife, coin, figurine, tool, pottery, jewelry, toy, etc.) 2) Brand/maker markings. 3) Material (metal, ceramic, wood, glass, etc.) 4) Era (antique, vintage, modern). 5) A short auction title (max 50 chars). 6) A 1-3 sentence description for buyers.`,
    `Return ONLY valid JSON. No markdown. No emojis.`,
    `{"title":"string (max 50 chars)","itemType":"string","brand":"string","material":"string","era":"string","description":"string (1-3 sentences)","confidence":0-100}`,
  ].join("\n");
}

function buildRetryPrompt(hints, firstResult) {
  const { folder } = hints;
  const base = `Your first attempt at identifying this item returned low confidence or incomplete data. Look MORE carefully this time.`;

  if (folder === "coins") {
    return [
      base,
      `ZOOM IN on: the DATE (numbers near the bottom of the obverse), the MINT MARK (tiny letter near the date — D, S, P, W, CC, O), the DENOMINATION text on the reverse, and the specific coin design name.`,
      `First attempt returned: ${JSON.stringify(firstResult._debug?.parsedObject || {})}`,
      `Correct any errors and fill in any blanks. Return ONLY valid JSON. No markdown. No emojis.`,
      buildSystemPrompt(hints).split("\n").slice(-1)[0],
    ].join("\n");
  }

  if (folder === "general") {
    return [
      base,
      `Look more carefully at any text, logos, stamps, markings, brand names, patent numbers, or maker marks anywhere on the item.`,
      `First attempt returned: ${JSON.stringify(firstResult._debug?.parsedObject || {})}`,
      `Correct any errors and fill in any blanks. Return ONLY valid JSON. No markdown. No emojis.`,
      buildSystemPrompt(hints).split("\n").slice(-1)[0],
    ].join("\n");
  }

  // Default retry for all other types
  return [
    base,
    `Examine all text in the photos more carefully — spine text, small print, labels, stickers, stamps.`,
    `First attempt returned: ${JSON.stringify(firstResult._debug?.parsedObject || {})}`,
    `Correct any errors and fill in any blanks. Return ONLY valid JSON. No markdown. No emojis.`,
    buildSystemPrompt(hints).split("\n").slice(-1)[0],
  ].join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// callAIForListing — Anthropic Claude Messages API
// ──────────────────────────────────────────────────────────────────────────────

async function callAIForListing(env, images, hints, quality) {
  const model = resolveModel(quality || "fast");
  const apiKey = resolveApiKey(env);
  const warnings = [];
  const _debug = { status: null, error: null, rawPreview: null, parsedObject: null, requestBodyPreview: null, model_used: null, model_attempts: [] };

  const systemPrompt = hints._retryPrompt || buildSystemPrompt(hints);

  const contentItems = [];
  for (const imgUrl of images) {
    contentItems.push({ type: "image", source: { type: "url", url: imgUrl } });
  }
  contentItems.push({ type: "text", text: systemPrompt });

  const requestBody = {
    model,
    max_tokens: 512,
    messages: [{ role: "user", content: contentItems }],
  };

  try { _debug.requestBodyPreview = JSON.stringify(requestBody).slice(0, 1200); } catch {}

  const attempt = { model, status: null, error: null };
  _debug.model_attempts.push(attempt);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20000);
  let resp = null, rawText = "";

  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(requestBody),
      signal: ac.signal,
    });
    attempt.status = resp.status;
    rawText = await resp.text();
  } catch (err) {
    attempt.error = `Fetch failed: ${err.message || String(err)}`;
    warnings.push(attempt.error);
    clearTimeout(timer);
    return fallbackResult(warnings, _debug);
  } finally { clearTimeout(timer); }

  _debug.model_used = model;
  _debug.status = resp.status;
  _debug.rawPreview = rawText.slice(0, 1200);

  if (!resp.ok) {
    _debug.error = `Anthropic HTTP ${resp.status}: ${rawText.slice(0, 600)}`;
    warnings.push(_debug.error);
    return fallbackResult(warnings, _debug);
  }

  let data;
  try { data = JSON.parse(rawText); }
  catch (err) { _debug.error = `JSON parse: ${err.message}`; warnings.push(_debug.error); return fallbackResult(warnings, _debug); }

  let outputText = "";
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === "text" && typeof block.text === "string") { outputText = block.text.trim(); break; }
    }
  }

  if (!outputText) {
    _debug.error = "No text in response. Keys: " + Object.keys(data).join(", ");
    warnings.push(_debug.error);
    return fallbackResult(warnings, _debug);
  }

  outputText = outputText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let parsed;
  try { parsed = JSON.parse(outputText); }
  catch (err) { _debug.error = `Model JSON fail: ${err.message}`; warnings.push(`Parse fail. Raw: ${outputText.slice(0, 400)}`); return fallbackResult(warnings, _debug); }

  _debug.parsedObject = parsed;

  return {
    artist: safeStr(parsed.artist) || "", album: safeStr(parsed.album) || "",
    label: safeStr(parsed.label) || "", catalogNumber: safeStr(parsed.catalogNumber) || "",
    author: safeStr(parsed.author) || "", title: safeStr(parsed.title) || "",
    format: safeStr(parsed.format) || "", year: safeStr(parsed.year) || "",
    rating: safeStr(parsed.rating) || "", issueDate: safeStr(parsed.issueDate) || "",
    itemType: safeStr(parsed.itemType) || "", brand: safeStr(parsed.brand) || "",
    material: safeStr(parsed.material) || "", era: safeStr(parsed.era) || "",
    description: safeStr(parsed.description) || "",
    denomination: safeStr(parsed.denomination) || "", coinType: safeStr(parsed.coinType) || "",
    mintMark: safeStr(parsed.mintMark) || "", metal: safeStr(parsed.metal) || "",
    country: safeStr(parsed.country) || "",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
    warnings, _debug,
  };
}

function fallbackResult(warnings, _debug) {
  return {
    artist: "", album: "", label: "", catalogNumber: "",
    author: "", title: "", format: "", year: "", rating: "",
    issueDate: "", itemType: "", brand: "", material: "", era: "",
    description: "", denomination: "", coinType: "", mintMark: "", metal: "",
    country: "", confidence: 0, warnings, _debug,
  };
}

function safeStr(v) { return (v === null || v === undefined) ? "" : String(v).trim(); }

// ──────────────────────────────────────────────────────────────────────────────
// Auto-retry: if confidence < 60 or title is blank/generic, retry with Sonnet
// ──────────────────────────────────────────────────────────────────────────────

function needsRetry(ai, folder, id) {
  // Low confidence
  if (typeof ai.confidence === "number" && ai.confidence < 60) return true;
  // Blank or generic title
  const t = safeStr(ai.title);
  if (!t) return true;
  if (t.startsWith("Lot ") || t.startsWith("Vinyl LP Lot") || t.startsWith("Book Lot") || t.startsWith("DVD Lot") || t.startsWith("Coin Lot") || t.startsWith("Magazine Lot")) return true;
  // For music: no artist found
  if ((folder === "vinyl_lp" || folder === "vinyl_45" || folder === "cd" || folder === "cassette") && !safeStr(ai.artist)) return true;
  // For coins: no year or denomination
  if (folder === "coins" && (!safeStr(ai.year) || !safeStr(ai.denomination))) return true;
  return false;
}

async function callAIWithRetry(env, images, hints, quality) {
  // First pass
  const firstResult = await callAIForListing(env, images, hints, quality);

  // Check if retry needed
  if (!needsRetry(firstResult, hints.folder, hints.id)) return firstResult;

  // Retry with quality model + retry prompt
  const retryPromptText = buildRetryPrompt(hints, firstResult);
  const retryHints = { ...hints, _retryPrompt: retryPromptText };
  const retryResult = await callAIForListing(env, images, retryHints, "quality");
  retryResult.warnings = [...(firstResult.warnings || []), "Auto-retried (low confidence)", ...(retryResult.warnings || [])];
  retryResult._debug.firstAttempt = firstResult._debug;
  return retryResult;
}

// ──────────────────────────────────────────────────────────────────────────────
// Field helpers
// ──────────────────────────────────────────────────────────────────────────────

function toImageCols(urls) {
  const out = {};
  for (let i = 0; i < 8; i++) out[`Image URL ${i + 1}`] = urls[i] || "";
  return out;
}

function noEmoji(s) { return (s || "").replace(/[\p{Extended_Pictographic}]/gu, "").trim(); }
function clamp50(s) { s = (s || "").trim(); return s.length > 50 ? s.slice(0, 50).trim() : s; }
function clampDesc(s) { s = (s || "").trim(); return s.length > 500 ? s.slice(0, 500).trim() : s; }

// ──────────────────────────────────────────────────────────────────────────────
// CSV helpers
// ──────────────────────────────────────────────────────────────────────────────

function escCsv(v) {
  const s = v === null || v === undefined ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(escCsv).join(",")];
  for (const r of rows) lines.push(headers.map((h) => escCsv(r[h] ?? "")).join(","));
  return lines.join("\n");
}

function escapeHtml(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
