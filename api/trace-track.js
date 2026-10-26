module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Método no permitido"
    });
  }

  const { trackingNumber, carrier } = req.body || {};

  if (!trackingNumber) {
    return res.status(400).json({
      ok: false,
      error: "Ingresá un número de seguimiento"
    });
  }

  const apiKey = process.env.TRACE_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      ok: false,
      error: "TRACE_API_KEY no está configurada"
    });
  }

  try {
    const body = {
      tracking_number: String(trackingNumber).trim(),
      allow_stale: true
    };

    if (carrier && carrier !== "auto") {
      body.carrier = String(carrier).trim().toLowerCase();
    }

    const response = await fetch(
      "https://api.traceapi.dev/v1/track",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        ok: false,
        error:
          data?.error ||
          data?.message ||
          "No pudimos consultar este seguimiento",
        details: data
      });
    }

    return res.status(200).json({
      ok: true,
      data
    });

  } catch (error) {
    console.error("Trace API error:", error);

    return res.status(500).json({
      ok: false,
      error: "Error al consultar Trace API"
    });
  }
};
