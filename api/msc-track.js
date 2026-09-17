export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Método no permitido"
    });
  }

  const container = String(req.query.container || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!/^[A-Z]{3}[UJZ][0-9]{7}$/.test(container)) {
    return res.status(400).json({
      ok: false,
      error: "Número de contenedor inválido"
    });
  }

  const officialUrl =
    `https://www.msc.com/en/track-a-shipment?tnumber=${encodeURIComponent(container)}`;

  try {
    const response = await fetch(officialUrl, {
      redirect: "follow",
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "PackPing/1.0"
      }
    });

    const html = await response.text();

    const titleMatch =
      html.match(/<title[^>]*>(.*?)<\/title>/is);

    const title = titleMatch
      ? titleMatch[1].replace(/\s+/g, " ").trim()
      : null;

    const lowerHtml = html.toLowerCase();

    const blocked =
      lowerHtml.includes("access denied") ||
      lowerHtml.includes("forbidden") ||
      lowerHtml.includes("permission to access");

    return res.status(200).json({
      ok: response.ok && !blocked,
      mscStatus: response.status,
      mscStatusText: response.statusText,
      blocked,
      title,
      receivedHtml: html.length > 0,
      htmlLength: html.length,
      containsContainer:
        lowerHtml.includes(container.toLowerCase()),
      officialUrl
    });

  } catch (error) {
    console.error("MSC tracking test error:", error);

    return res.status(500).json({
      ok: false,
      error: "No pudimos consultar MSC",
      details: error.message,
      officialUrl
    });
  }
}
