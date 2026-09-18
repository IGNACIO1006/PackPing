export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Método no permitido"
    });
  }

  const tracking = String(
    req.query.tracking || req.query.number || ""
  )
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  if (!tracking || tracking.length < 5) {
    return res.status(400).json({
      ok: false,
      error: "Número de seguimiento inválido"
    });
  }

  const correoUrl =
    "https://ahiva.correo.com.uy/" +
    "servicioConsultaTntIps-ws/" +
    "seguimientoEnvios/eventosweb" +
    "?codigoPieza=" +
    encodeURIComponent(tracking);

  try {
    const response = await fetch(correoUrl, {
      headers: {
        Accept: "application/json"
      }
    });

    const rawText = await response.text();

    let data;

    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(502).json({
        ok: false,
        error: "Correo Uruguayo respondió en un formato inesperado",
        correoStatus: response.status
      });
    }

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        error: "Correo Uruguayo no respondió correctamente",
        correoStatus: response.status
      });
    }

    const shipment = Array.isArray(data)
      ? data[0]
      : data;

    if (!shipment) {
      return res.status(404).json({
        ok: false,
        error: "No encontramos información para este envío"
      });
    }

    if (shipment.estado === "NOT_FOUND") {
      return res.status(404).json({
        ok: false,
        error: "No encontramos información para este envío",
        carrier: "Correo Uruguayo",
        tracking,
        correoState: shipment.estado
      });
    }

    const events = Array.isArray(shipment.eventos)
      ? shipment.eventos.map(event => ({
          date: event.fecha || null,
          message: event.evento || null,
          location: event.ubicacion || null,
          eventCode: event.codigoevento || null,
          source: event.fuenteevento || null,
          deliveryInfo: event.infoentrega || null
        }))
      : [];

    const latestEvent = events.length
      ? events[0]
      : null;

    res.setHeader(
      "Cache-Control",
      "s-maxage=60, stale-while-revalidate=120"
    );

    return res.status(200).json({
      ok: true,
      carrier: "Correo Uruguayo",
      tracking,
      state: shipment.estado || null,
      deliveryStage: shipment.codigoEtapaEntrega || null,
      latestEvent,
      events
    });

  } catch (error) {
    console.error("Correo Uruguayo tracking error:", error);

    return res.status(500).json({
      ok: false,
      error: "No pudimos consultar Correo Uruguayo"
    });
  }
}
