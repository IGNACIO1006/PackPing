module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método no permitido"
    });
  }

  const { trackingNumber, carrier } = req.body || {};

  if (!trackingNumber) {
    return res.status(400).json({
      error: "Ingresá un número de seguimiento"
    });
  }

  const cleanTracking = String(trackingNumber)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  const normalizedCarrier = String(carrier || "")
    .trim()
    .toLowerCase();

  const isCorreoUruguayo = [
    "correo uruguayo",
    "correo-uy",
    "correo_uy",
    "correo"
  ].includes(normalizedCarrier);

  // =====================================================
  // CORREO URUGUAYO - DIRECTO, SIN AFTERSHIP
  // =====================================================

  if (isCorreoUruguayo) {
    const correoUrl =
      "https://ahiva.correo.com.uy/" +
      "servicioConsultaTntIps-ws/" +
      "seguimientoEnvios/eventosweb" +
      "?codigoPieza=" +
      encodeURIComponent(cleanTracking);

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
          error: "Correo Uruguayo respondió en un formato inesperado"
        });
      }

      if (!response.ok) {
        return res.status(502).json({
          error: "Correo Uruguayo no respondió correctamente"
        });
      }

      const shipment = Array.isArray(data)
        ? data[0]
        : data;

      if (!shipment || shipment.estado === "NOT_FOUND") {
        return res.status(404).json({
          error: "No encontramos información para este envío"
        });
      }

      const events = Array.isArray(shipment.eventos)
        ? shipment.eventos.map(event => ({
            date: event.fecha || null,
            message: event.evento || null,
            location: event.ubicacion || null,
            eventCode: event.codigoevento || null,
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
        source: "correo-uruguayo",
        carrier: "Correo Uruguayo",
        trackingNumber: cleanTracking,
        state: shipment.estado || null,
        deliveryStage: shipment.codigoEtapaEntrega || null,
        latestEvent,
        events
      });

    } catch (error) {
      console.error("Correo Uruguayo tracking error:", error);

      return res.status(500).json({
        error: "No pudimos consultar Correo Uruguayo"
      });
    }
  }

  // =====================================================
  // RESTO DE TRANSPORTISTAS - AFTERSHIP TEMPORALMENTE
  // =====================================================

  const apiKey = process.env.AFTERSHIP_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "La API de seguimiento no está configurada"
    });
  }

  try {
    const tracking = {
      tracking_number: trackingNumber.trim()
    };

    const carrierMap = {
      DHL: "dhl",
      FedEx: "fedex",
      UPS: "ups"
    };

    if (
      carrier &&
      carrier !== "auto" &&
      carrierMap[carrier]
    ) {
      tracking.slug = carrierMap[carrier];
    }

    const response = await fetch(
      "https://api.aftership.com/tracking/2026-07/trackings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "as-api-key": apiKey
        },
        body: JSON.stringify(tracking)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      const searchResponse = await fetch(
        `https://api.aftership.com/tracking/2026-07/trackings?tracking_numbers=${encodeURIComponent(
          trackingNumber.trim()
        )}`,
        {
          headers: {
            "Content-Type": "application/json",
            "as-api-key": apiKey
          }
        }
      );

      const searchData = await searchResponse.json();

      if (searchResponse.ok) {
        return res.status(200).json(searchData);
      }

      return res.status(response.status).json({
        error:
          data?.meta?.message ||
          "No pudimos consultar este número de seguimiento",
        details: data
      });
    }

    return res.status(200).json(data);

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      error: "Error al consultar el seguimiento"
    });
  }
};
