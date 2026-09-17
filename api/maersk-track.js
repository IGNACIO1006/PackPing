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

  const maerskUrl =
    `https://api.maersk.com/synergy/tracking/${encodeURIComponent(container)}?operator=MAEU`;

  const officialUrl =
    `https://www.maersk.com/tracking/${encodeURIComponent(container)}`;

  try {
    const response = await fetch(maerskUrl, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "PackPing/1.0"
      }
    });

    const raw = await response.text();

    let data = null;

    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: "Maersk no devolvió seguimiento",
        maerskStatus: response.status,
        maerskStatusText: response.statusText,
        response: data || raw.slice(0, 500),
        officialUrl
      });
    }

    res.setHeader(
      "Cache-Control",
      "s-maxage=120, stale-while-revalidate=300"
    );

    return res.status(200).json({
      ok: true,
      carrier: "Maersk",
      container,
      data,
      officialUrl
    });

  } catch (error) {
    console.error("Maersk tracking error:", error);

    return res.status(500).json({
      ok: false,
      error: "No pudimos consultar Maersk",
      officialUrl
    });
  }
}
