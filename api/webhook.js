module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "PackPing AfterShip Webhook"
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Metodo no permitido"
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
  const resendKey = process.env.RESEND_API_KEY;

  if (!supabaseUrl || !supabaseSecret || !resendKey) {
    console.error("Faltan variables de entorno");

    return res.status(500).json({
      error: "Configuracion incompleta"
    });
  }

  function escapeHtml(value = "") {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  const statusNames = {
    Pending: "Pendiente",
    InfoReceived: "Informacion recibida",
    InTransit: "En transito",
    OutForDelivery: "En reparto",
    AttemptFail: "Intento de entrega fallido",
    Delivered: "Entregado",
    AvailableForPickup: "Disponible para retirar",
    Exception: "Requiere atencion",
    Expired: "Sin actualizaciones"
  };

  try {
    const event = req.body || {};
    const msg = event.msg || {};
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
      "Transportista";

    const checkpoints =
      tracking.checkpoints ||
      msg.checkpoints ||
      [];

    const latestCheckpoint =
      checkpoints.length
        ? checkpoints[checkpoints.length - 1]
        : null;

    const latestMessage =
      latestCheckpoint?.subtag_message ||
      latestCheckpoint?.message ||
      tracking.subtag_message ||
      status ||
      "Nueva actualizacion";

    const location =
      latestCheckpoint?.location ||
      [
        latestCheckpoint?.city,
        latestCheckpoint?.state,
        latestCheckpoint?.country_region_name
      ]
        .filter(Boolean)
        .join(", ");

    console.log("AfterShip webhook recibido:", {
      event: event.event,
      event_id: event.event_id,
      trackingNumber,
      status,
      carrier
    });

    if (!trackingNumber) {
      return res.status(200).json({
        received: true,
        followers: 0
      });
    }

    // Buscar quienes tienen activada la campana
    const followersUrl =
      `${supabaseUrl}/rest/v1/followed_shipments` +
      `?tracking_number=eq.${encodeURIComponent(trackingNumber)}` +
      `&notifications_enabled=eq.true` +
      `&select=id,user_id,tracking_number,carrier,current_status,last_checkpoint,last_event_id`;

    const followersResponse = await fetch(followersUrl, {
      headers: {
        apikey: supabaseSecret,
        Authorization: `Bearer ${supabaseSecret}`
      }
    });

    if (!followersResponse.ok) {
      console.error(
        "Error consultando seguidores:",
        await followersResponse.text()
      );

      return res.status(500).json({
        error: "Error consultando seguidores"
      });
    }

    const followers = await followersResponse.json();

    console.log(
      `PackPing encontro ${followers.length} usuario(s) siguiendo ${trackingNumber}`
    );

    let emailsSent = 0;

    for (const follower of followers) {
      // AfterShip reintento el mismo evento
      if (
        event.event_id &&
        follower.last_event_id === event.event_id
      ) {
        console.log("Evento duplicado ignorado:", event.event_id);
        continue;
      }

      const statusChanged =
        status &&
        follower.current_status !== status;

      const checkpointChanged =
        latestMessage &&
        follower.last_checkpoint !== latestMessage;

      if (!statusChanged && !checkpointChanged) {
        continue;
      }

      // Obtener email del usuario desde Supabase Auth
      const userResponse = await fetch(
        `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(
          follower.user_id
        )}`,
        {
          headers: {
            apikey: supabaseSecret,
            Authorization: `Bearer ${supabaseSecret}`
          }
        }
      );

      if (!userResponse.ok) {
        console.error(
          "No se pudo obtener el usuario:",
          await userResponse.text()
        );
        continue;
      }

      const userData = await userResponse.json();
      const user = userData.user || userData;
      const email = user.email;

      if (!email) {
        console.log("Usuario sin email:", follower.user_id);
        continue;
      }

      const friendlyStatus =
        statusNames[status] ||
        status ||
        "Nueva actualizacion";

      let subject = `Actualizacion de tu envio: ${friendlyStatus}`;

      if (status === "OutForDelivery") {
        subject = "Tu paquete esta en reparto";
      }

      if (status === "Delivered") {
        subject = "Tu paquete fue entregado";
      }

      if (status === "Exception") {
        subject = "Tu envio requiere atencion";
      }

      const emailResponse = await fetch(
        "https://api.resend.com/emails",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${resendKey}`,
            "Content-Type": "application/json",
            "Idempotency-Key":
  `packping-v2-${event.event_id || Date.now()}-${follower.user_id}`
          },
          body: JSON.stringify({
            from: "PackPing <onboarding@resend.dev>",
            to: [email],
            subject,
html: `
  <div style="
    font-family:Arial,Helvetica,sans-serif;
    max-width:560px;
    margin:0 auto;
    padding:30px 20px;
    color:#0f2040;
  ">

    <div style="margin-bottom:28px;">
  <img
    src="https://pack-ping.vercel.app/logo-email.png"
    alt="PackPing"
    width="150"
    style="
      display:block;
      width:150px;
      height:auto;
      border:0;
    "
  >
</div>

      <span style="
        display:inline-block;
        vertical-align:middle;
        font-size:28px;
        font-weight:700;
        color:#2F66E8;
      ">
        PackPing
      </span>
    </div>

    <h2 style="
      margin:0 0 10px;
      font-size:24px;
      color:#0f2040;
    ">
      Tu envío tiene una nueva actualización
    </h2>

    <p style="
      margin:0 0 24px;
      font-size:16px;
      color:#475569;
    ">
      Hay novedades en uno de los envíos que estás siguiendo.
    </p>

    <div style="
      background:#F7F9FC;
      border:1px solid #E2E8F0;
      border-radius:16px;
      padding:22px;
      margin-bottom:24px;
    ">

      <p style="
        margin:0 0 6px;
        font-size:15px;
        font-weight:700;
        color:#0f2040;
        text-transform:uppercase;
      ">
        ${escapeHtml(carrier)}
      </p>

      <p style="
        margin:0 0 18px;
        color:#64748B;
        font-size:15px;
      ">
        ${escapeHtml(trackingNumber)}
      </p>

      <p style="
        margin:0 0 8px;
        font-size:23px;
        font-weight:700;
        color:#0f2040;
      ">
        ${escapeHtml(friendlyStatus)}
      </p>

      <p style="
        margin:0;
        font-size:16px;
        color:#334155;
      ">
        ${escapeHtml(latestMessage)}
      </p>

      ${
        location
          ? `
            <p style="
              margin:14px 0 0;
              color:#64748B;
              font-size:14px;
            ">
              📍 ${escapeHtml(location)}
            </p>
          `
          : ""
      }

    </div>

    <a
      href="https://pack-ping.vercel.app/"
      target="_blank"
      style="
        display:inline-block;
        background:#2F66E8;
        color:#FFFFFF;
        text-decoration:none;
        padding:14px 24px;
        border-radius:10px;
        font-size:16px;
        font-weight:700;
      "
    >
      Ver en PackPing
    </a>

    <p style="
      margin-top:28px;
      color:#94A3B8;
      font-size:12px;
      line-height:1.5;
    ">
      Recibís este correo porque activaste la campana para este envío en PackPing.
    </p>

  </div>
`
          })
        }
      );

      if (!emailResponse.ok) {
        console.error(
          "Resend no pudo enviar el correo:",
          await emailResponse.text()
        );
        continue;
      }

      const emailData = await emailResponse.json();

      console.log("Email enviado:", {
        trackingNumber,
        email_id: emailData.id
      });

      emailsSent += 1;

      // Guardar el ultimo evento procesado
      const updateResponse = await fetch(
        `${supabaseUrl}/rest/v1/followed_shipments?id=eq.${encodeURIComponent(
          follower.id
        )}`,
        {
          method: "PATCH",
          headers: {
            apikey: supabaseSecret,
            Authorization: `Bearer ${supabaseSecret}`,
            "Content-Type": "application/json",
            Prefer: "return=minimal"
          },
          body: JSON.stringify({
            current_status: status || null,
            last_checkpoint: latestMessage || null,
            last_event_id: event.event_id || null,

            // Despues de Delivered ya no hacen falta mas avisos
            notifications_enabled:
              status === "Delivered"
                ? false
                : true,

            updated_at: new Date().toISOString()
          })
        }
      );

      if (!updateResponse.ok) {
        console.error(
          "No se pudo actualizar followed_shipments:",
          await updateResponse.text()
        );
      }
    }

    return res.status(200).json({
      received: true,
      tracking_number: trackingNumber,
      followers: followers.length,
      emails_sent: emailsSent
    });

  } catch (error) {
    console.error("Error procesando webhook:", error);

    return res.status(500).json({
      error: "Error procesando webhook"
    });
  }
};
