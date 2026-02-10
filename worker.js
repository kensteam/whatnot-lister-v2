export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    // Upload + Process => returns one CSV row + stores images in R2
    if (url.pathname === "/process" && request.method === "POST") {
      // Expect multipart/form-data:
      // - mediaType: LP | 45 | CD | CASSETTE
      // - itemId: 5000 (optional)
      // - files: images[]
      const form = await request.formData();
      const mediaType = (form.get("mediaType") || "").toString().toUpperCase();
      const itemId = (form.get("itemId") || "").toString().trim() || crypto.randomUUID().slice(0, 8);

      const files = form.getAll("images");
      if (!files || files.length < 2) return json({ error: "Upload at least 2 images." }, 400);

      // Upload images to R2
      const uploadedUrls = [];
      for (let i = 0; i < Math.min(files.length, 8); i++) {
        const file = files[i];
        if (!(file instanceof File)) continue;

        const ext = guessExt(file.type) || "jpg";
        const key = `inbox/${itemId}/${String(i + 1).padStart(2, "0")}.${ext}`;

        await env.R2.put(key, await file.arrayBuffer(), {
          httpMetadata: { contentType: file.type || "image/jpeg" },
        });

        // Public URL pattern (you already have an r2.dev public base)
        const publicBase = env.R2_PUBLIC_BASE_URL?.replace(/\/$/, "");
        uploadedUrls.push(`${publicBase}/${key}`);
      }

      // Determine Whatnot fields
      const spec = whatnotSpec(mediaType);

      // Use OpenAI Vision to extract Artist + Title (no value estimates)
      const extracted = await extractArtistTitle(env, uploadedUrls, mediaType);

      const safeArtist = extracted.artist || "Unknown Artist";
      const safeTitle = extracted.title || "Unknown Title";

      const title = clampTitle(`${safeArtist} - ${safeTitle} ${spec.suffix}`, 50);
      const description = [
        `Artist: ${safeArtist}`,
        `Title: ${safeTitle}`,
        `Format: ${spec.formatLine}`,
        `Condition: `, // blank on purpose
      ].join("\n");

      // Build CSV row matching Whatnot template columns
      const row = {
        Category: spec.category,
        "Sub Category": spec.subCategory,
        Title: title,
        Description: description,
        Quantity: "1",
        Type: "Auction",
        Price: String(spec.price),
        "Shipping Profile": spec.shippingProfile,
        Offerable: "",
        Condition: "",
        Hazmat: "Not Hazmat",
        "Image URL 1": uploadedUrls[0] || "",
        "Image URL 2": uploadedUrls[1] || "",
        "Image URL 3": uploadedUrls[2] || "",
        "Image URL 4": uploadedUrls[3] || "",
        "Image URL 5": uploadedUrls[4] || "",
        "Image URL 6": uploadedUrls[5] || "",
        "Image URL 7": uploadedUrls[6] || "",
        "Image URL 8": uploadedUrls[7] || "",
      };

      return json({ itemId, uploadedUrls, row });
    }

    return new Response("Not found", { status: 404, headers: corsHeaders() });
  },
};

function whatnotSpec(mediaType) {
  // Media types: LP | 45 | CD | CASSETTE
  if (mediaType === "LP") {
    return {
      category: "Music",
      subCategory: "Vinyl Records",
      shippingProfile: "1 lb",
      price: 5,
      suffix: "LP",
      formatLine: "Vinyl LP",
    };
  }
  if (mediaType === "45") {
    return {
      category: "Music",
      subCategory: "Vinyl Records",
      shippingProfile: "4-7 oz",
      price: 3,
      suffix: "45",
      formatLine: "7-inch 45 RPM",
    };
  }
  if (mediaType === "CD") {
    return {
      category: "Music",
      subCategory: "CDs & Cassettes",
      shippingProfile: "4-7 oz",
      price: 3,
      suffix: "CD",
      formatLine: "Compact Disc (CD)",
    };
  }
  if (mediaType === "CASSETTE") {
    return {
      category: "Music",
      subCategory: "CDs & Cassettes",
      shippingProfile: "4-7 oz",
      price: 3,
      suffix: "Cassette",
      formatLine: "Cassette Tape",
    };
  }
  // Default to LP
  return {
    category: "Music",
    subCategory: "Vinyl Records",
    shippingProfile: "1 lb",
    price: 5,
    suffix: "LP",
    formatLine: "Vinyl LP",
  };
}

async function extractArtistTitle(env, imageUrls, mediaType) {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return { artist: "", title: "" };

  const prompt = [
    `You are reading product photos to create a Whatnot auction listing.`,
    `Return ONLY JSON: {"artist":"...","title":"..."}`,
    `Rules:`,
    `- No value estimates.`,
    `- Artist and title must be taken from the cover/label text.`,
    `- If unsure, return empty strings.`,
    `Media type: ${mediaType}`,
  ].join("\n");

  // OpenAI Responses API (multimodal)
  const body = {
    model: env.OPENAI_MODEL || "gpt-4.1-mini",
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: prompt },
          ...imageUrls.map((u) => ({ type: "input_image", image_url: u })),
        ],
      },
    ],
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) return { artist: "", title: "" };
  const data = await resp.json();

  // Pull text output then parse JSON
  const text = (data.output_text || "").trim();
  try {
    const j = JSON.parse(text);
    return { artist: (j.artist || "").trim(), title: (j.title || "").trim() };
  } catch {
    return { artist: "", title: "" };
  }
}

function clampTitle(s, max) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : t.slice(0, max).trim();
}

function guessExt(mime) {
  if (!mime) return "jpg";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  return "jpg";
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST,GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
