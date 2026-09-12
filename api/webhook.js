module.exports = async function handler(req, res) {
  // Comprobación rápida desde navegador
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "PackPing AfterShip Webhook"
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Método no permitido"
    });
  }

  const webhookSecret = process.env.AFTERSHIP_WEBHOOK_TOKEN;
  const receivedSecret = req.headers["x-packping-secret"];

  if (!webhookSecret || receivedSecret !== webhookSecret) {
    return res.status(401).json({
      error: "Webhook no autorizado"
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecret = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseSecret) {
    console.error("Faltan variables de Supabase");

    return res.status(500).json({
      error: "Supabase no configurado"
    });
  }

  try {
    const event = req.body || {};
    const msg = event.msg || {};

    // AfterShip puede enviar los datos directamente en msg
    // o dentro de msg.tracking según el tipo/version del evento.
    const tracking = msg.tracking || msg;

    const trackingNumber =
      tracking.tracking_number ||
      msg.tracking_number ||
      "";

    const status =
      tracking.tag ||
      msg.tag ||
      "";

    const carrier =
      tracking.slug ||
      msg.slug ||
      "";

    const checkpoints =
      tracking.checkpoints ||
      msg.checkpoints ||
      [];

    const latestCheckpoint =
      checkpoints.length > 0
        ? checkpoints[checkpoints.length - 1]
        : null;

    const latestMessage =
      latestCheckpoint?.subtag_message ||
      latestCheckpoint?.message ||
      tracking.subtag_message ||
      status ||
      "";

    console.log("AfterShip webhook recibido:", {
      event: event.event,
      event_id: event.event_id,
      trackingNumber,
      status,
      carrier
    });

    // Un test de AfterShip podría no traer un tracking real.
    if (!trackingNumber) {
      console.log("Webhook sin tracking_number");

      return res.status(200).json({
        received: true,
        followers: 0
      });
    }

    // Buscar usuarios que estén siguiendo ese tracking
    const queryUrl =
      `${supabaseUrl}/rest/v1/followed_shipments` +
      `?tracking_number=eq.${encodeURIComponent(trackingNumber)}` +
      `&notifications_enabled=eq.true` +
      `&select=id,user_id,tracking_number,carrier,current_status,last_checkpoint`;

    const followersResponse = await fetch(queryUrl, {
      headers: {
        apikey: supabaseSecret
      }
    });

    if (!followersResponse.ok) {
      const text = await followersResponse.text();

      console.error("Error consultando Supabase:", text);

      return res.status(500).json({
        error: "No pudimos consultar los seguidores"
      });
    }

    const followers = await followersResponse.json();

    console.log(
      `PackPing encontró ${followers.length} usuario(s) siguiendo ${trackingNumber}`
    );

    // Actualizamos el estado guardado
    if (followers.length > 0) {
      const updateUrl =
        `${supabaseUrl}/rest/v1/followed_shipments` +
        `?tracking_number=eq.${encodeURIComponent(trackingNumber)}` +
        `&notifications_enabled=eq.true`;

      const updateResponse = await fetch(updateUrl, {
        method: "PATCH",
        headers: {
          apikey: supabaseSecret,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          current_status: status || null,
          last_checkpoint: latestMessage || null,
          updated_at: new Date().toISOString()
        })
      });

      if (!updateResponse.ok) {
        console.error(
          "No se pudo actualizar el estado:",
          await updateResponse.text()
        );
      }
    }

    return res.status(200).json({
      received: true,
      tracking_number: trackingNumber,
      followers: followers.length
    });

  } catch (error) {
    console.error("Error procesando webhook:", error);

    return res.status(500).json({
      error: "Error procesando webhook"
    });
  }
};
