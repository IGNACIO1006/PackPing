function decodeHtml(text = "") {
  return String(text)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function cleanText(html = "") {
  return decodeHtml(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function extractField(text, regex) {
  const match = text.match(regex);
  return match ? match[1].trim() : null;
}

function parseEvents(html) {
  const events = [];

  const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];

  for (const row of rows) {
    const cells = [];

    const cellRegex = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let match;

    while ((match = cellRegex.exec(row)) !== null) {
      cells.push(cleanText(match[1]));
    }

    const dateIndex = cells.findIndex(cell =>
      /^\d{4}-\d{2}-\d{2}$/.test(cell)
    );

    if (dateIndex < 2) continue;

    const status = cells[0] || "";
    const place = cells[1] || "";
    const date = cells[dateIndex] || "";

    let time = "";
    let transportIndex = dateIndex + 1;

    if (/^\d{2}:\d{2}$/.test(cells[dateIndex + 1] || "")) {
      time = cells[dateIndex + 1];
      transportIndex = dateIndex + 2;
    }

    const transport = cells[transportIndex] || "";
    const voyage = cells[transportIndex + 1] || "";

    const actual =
      /<(strong|b)\b/i.test(row) ||
      /font-weight\s*:\s*(bold|700)/i.test(row);

    events.push({
      status,
      place,
      date,
      time,
      transport,
      voyage,
      actual
    });
  }

  return events;
}

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

  const formattedContainer =
    container.slice(0, 4) + "++" + container.slice(4);

  const officialUrl =
    "https://www.hapag-lloyd.com/en/online-business/documentation/shipments-solution.html" +
    "?container=" +
    formattedContainer +
    "&view=S8510";

  try {
    const response = await fetch(officialUrl, {
      headers: {
        "User-Agent": "PackPing/1.0",
        "Accept": "text/html",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });

   if (!response.ok) {
  return res.status(502).json({
    ok: false,
    error: "Hapag-Lloyd no respondió correctamente",
    hapagStatus: response.status,
    hapagStatusText: response.statusText,
    officialUrl
  });
}

    const html = await response.text();
    const text = cleanText(html);

    const type = extractField(
      text,
      /Container Information\s+Type\s+(.+?)\s+Description/i
    );

    const description = extractField(
      text,
      /Description\s+(.+?)\s+Dimension/i
    );

    const dimension = extractField(
      text,
      /Dimension\s+(.+?)\s+Tare\s+\(kg\)/i
    );

    const tareKg = extractField(
      text,
      /Tare\s+\(kg\)\s+(\d+)/i
    );

    const maxPayloadKg = extractField(
      text,
      /Max\.\s*Payload\s+\(kg\)\s+(\d+)/i
    );

    const lastMovement = extractField(
      text,
      /Last Movement\s+(.+?)\s+Status\s+Place of Activity/i
    );

    const events = parseEvents(html);

    if (!type && !lastMovement && events.length === 0) {
      return res.status(404).json({
        ok: false,
        error: "No encontramos información pública para este contenedor",
        container,
        officialUrl
      });
    }

    res.setHeader(
      "Cache-Control",
      "s-maxage=120, stale-while-revalidate=300"
    );

    return res.status(200).json({
      ok: true,
      carrier: "Hapag-Lloyd",
      container,

      containerInfo: {
        type,
        description,
        dimension,
        tareKg: tareKg ? Number(tareKg) : null,
        maxPayloadKg: maxPayloadKg
          ? Number(maxPayloadKg)
          : null
      },

      lastMovement,

      events,

      officialUrl
    });

  } catch (error) {
    console.error("Hapag-Lloyd tracking error:", error);

    return res.status(500).json({
      ok: false,
      error: "No pudimos consultar Hapag-Lloyd",
      officialUrl
    });
  }
}
