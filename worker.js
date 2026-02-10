export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1) Button page
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Whatnot Lister v2</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;max-width:720px;margin:40px auto;padding:0 16px}
    button{font-size:18px;padding:14px 18px;border-radius:10px;border:0;cursor:pointer}
    .ok{margin-top:14px;white-space:pre-wrap}
  </style>
</head>
<body>
  <h1>Whatnot Lister v2</h1>
  <button id="go">Process Images</button>
  <div class="ok" id="msg"></div>

  <script>
    const btn = document.getElementById('go');
    const msg = document.getElementById('msg');

    btn.onclick = async () => {
      btn.disabled = true;
      msg.textContent = "Processing…";
      try {
        const res = await fetch("/process", { method: "POST" });
        if (!res.ok) throw new Error("Process failed: " + res.status);

        const blob = await res.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "whatnot_upload.csv";
        document.body.appendChild(a);
        a.click();
        a.remove();

        msg.textContent = "Done. CSV downloaded.";
      } catch (e) {
        msg.textContent = String(e);
      } finally {
        btn.disabled = false;
      }
    };
  </script>
</body>
</html>`.trim(), {
        headers: { "content-type": "text/html; charset=utf-8" }
      });
    }

    // 2) Process → return CSV download (placeholder)
    if (request.method === "POST" && url.pathname === "/process") {
      const csvHeader = [
        "Category","Sub Category","Title","Description","Quantity","Type","Price",
        "Shipping Profile","Offerable","Hazmat","Condition","Cost Per Item","SKU",
        "Image URL 1","Image URL 2","Image URL 3","Image URL 4","Image URL 5","Image URL 6","Image URL 7","Image URL 8"
      ].join(",");

      // Minimal demo row (we'll replace with real rows)
      const row = [
        "Music","Vinyl Records","TEST ITEM","TEST DESC","1","Auction","5",
        "1-2 lbs","TRUE","Not Hazmat","", "", "test_sku",
        "https://example.com/image1.jpg","","","","","","",""
      ].map(v => `"${String(v).replaceAll('"','""')}"`).join(",");

      const csv = csvHeader + "\n" + row + "\n";

      return new Response(csv, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="whatnot_upload.csv"`,
          "cache-control": "no-store"
        }
      });
    }

    return new Response("Not found", { status: 404 });
  }
};
