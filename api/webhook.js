module.exports = async function handler(req, res) {
  // Sirve para comprobar desde el navegador que el endpoint existe
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "PackPing AfterShip Webhook"
    });
  }

  // AfterShip enviará POST
  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método no permitido"
    });
  }

  const expectedSecret = process.env.AFTERSHIP_WEBHOOK_TOKEN;
  const receivedSecret = req.headers["x-packping-secret"];

  if (!expectedSecret) {
    return res.status(500).json({
      error: "Webhook secret no configurado"
    });
  }

  if (receivedSecret !== expectedSecret) {
    return res.status(401).json({
      error: "Webhook no autorizado"
    });
  }

  try {
    const event = req.body || {};

    console.log("Webhook AfterShip recibido:", {
      event: event.event,
      event_id: event.event_id
    });

    return res.status(200).json({
      received: true
    });
  } catch (error) {
    console.error("Error procesando webhook:", error);

    return res.status(500).json({
      error: "Error procesando webhook"
    });
  }
};
