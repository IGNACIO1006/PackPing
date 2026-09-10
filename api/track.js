export default async function handler(req, res) {
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

    // Si el usuario eligió una empresa concreta,
    // enviamos el slug a AfterShip.
    const carrierMap = {
      DHL: "dhl",
      FedEx: "fedex",
      UPS: "ups"
      "Correo Uruguayo": "correo-uy"
    };

    if (carrier && carrier !== "auto" && carrierMap[carrier]) {
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

    // Si el tracking ya existe, intentamos buscarlo.
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
}
