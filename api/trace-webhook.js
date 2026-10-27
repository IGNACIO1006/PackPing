function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);

  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}

async function verifyTraceSignature(
  request,
  rawBody,
  webhookSecret
) {
  const signatureHeader =
    request.headers.get("trace-signature") || "";

  const timestampHeader =
    request.headers.get("trace-timestamp") || "";

  const parts = signatureHeader
    .split(",")
    .map(part => part.split("="));

  const times = parts.filter(
    ([key]) => key === "t"
  );

  if (times.length !== 1) {
    return false;
  }

  const timestamp = times[0][1];

  if (!/^\d+$/.test(timestamp)) {
    return false;
  }

  if (timestampHeader !== timestamp) {
    return false;
  }

  if (
    Math.abs(Date.now() / 1000 - Number(timestamp)) >
    300
  ) {
    return false;
  }

  const signatures = parts
    .filter(([key]) => key === "v1")
    .map(([, value]) => value)
    .filter(value =>
      /^[a-f0-9]{64}$/i.test(value || "")
    );

  if (!signatures.length) {
    return false;
  }

  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(webhookSecret),
    {
      name: "HMAC",
      hash: "SHA-256"
    },
    false,
    ["verify"]
  );

  const signedPayload =
    encoder.encode(`${timestamp}.${rawBody}`);

  for (const signature of signatures) {
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      hexToBytes(signature),
      signedPayload
    );

    if (valid) {
      return true;
    }
  }

  return false;
}

function traceStatusToPackPing(status) {
  switch (String(status || "").toLowerCase()) {
    case "delivered":
      return "Delivered";

    case "out_for_delivery":
      return "OutForDelivery";

    case "exception":
      return "Exception";

    case "pending":
      return "Pending";

    case "customs":
    case "in_transit":
    default:
      return "InTransit";
  }
}

const statusNames = {
  Pending: "Pendiente",
  InTransit: "En tránsito",
  OutForDelivery: "En reparto",
  Delivered: "Entregado",
  Exception: "Requiere atención"
};

export async function GET() {
  return Response.json({
    ok: true,
    service: "PackPing Trace Webhook"
  });
}

export async function POST(request) {
  const webhookSecret =
    process.env.TRACE_WEBHOOK_SECRET;

  const supabaseUrl =
    process.env.SUPABASE_URL;

  const supabaseSecret =
    process.env.SUPABASE_SECRET_KEY;

  const resendKey =
    process.env.RESEND_API_KEY;

  if (
    !webhookSecret ||
    !supabaseUrl ||
    !supabaseSecret ||
    !resendKey
  ) {
    console.error("Faltan variables de entorno");

    return Response.json(
      {
        ok: false,
        error: "Configuración incompleta"
      },
      {
        status: 500
      }
    );
  }

  const rawBody = await request.text();

  const trusted =
    await verifyTraceSignature(
      request,
      rawBody,
      webhookSecret
    );

  if (!trusted) {
    return Response.json(
      {
        ok: false,
        error: "Firma inválida"
      },
      {
        status: 401
      }
    );
  }

  let payload;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json(
      {
        ok: false,
        error: "JSON inválido"
      },
      {
        status: 400
      }
    );
  }

  const eventId =
    request.headers.get("trace-event-id") ||
    payload.event_id ||
    null;

  const eventType =
    payload.event_type ||
    request.headers.get("trace-event") ||
    null;

  const tracking =
    payload.tracking || {};

  const trackingNumber =
    String(
      tracking.tracking_number || ""
    ).trim();

  if (!trackingNumber) {
    return Response.json({
      ok: true,
      received: true,
      followers: 0
    });
  }

  const statusRaw =
    tracking.status || "";

  const status =
    traceStatusToPackPing(statusRaw);

  const carrier =
    tracking.carrier?.name ||
    tracking.carrier?.code ||
    "Transportista";

  const events =
    Array.isArray(tracking.events)
      ? tracking.events
      : [];

  const latestEvent =
    events.length
      ? events[events.length - 1]
      : null;

  const latestMessage =
    latestEvent?.description ||
    statusNames[status] ||
    "Nueva actualización";

  const location =
    latestEvent?.location || "";

  console.log("Trace webhook recibido:", {
    eventId,
    eventType,
    trackingNumber,
    status,
    carrier
  });

  try {
    // Buscar usuarios que siguen este paquete
    const followersUrl =
      `${supabaseUrl}/rest/v1/followed_shipments` +
      `?tracking_number=eq.${encodeURIComponent(
        trackingNumber
      )}` +
      `&notifications_enabled=eq.true` +
      `&select=id,user_id,tracking_number,carrier,reference_name,current_status,last_checkpoint,last_event_id`;

    const followersResponse =
      await fetch(followersUrl, {
        headers: {
          apikey: supabaseSecret,
          Authorization:
            `Bearer ${supabaseSecret}`
        }
      });

    if (!followersResponse.ok) {
      console.error(
        "Error consultando seguidores:",
        await followersResponse.text()
      );

      return Response.json(
        {
          error: "Error consultando seguidores"
        },
        {
          status: 500
        }
      );
    }

    const followers =
      await followersResponse.json();

    console.log(
      `PackPing encontró ${followers.length} usuario(s) siguiendo ${trackingNumber}`
    );

    let emailsSent = 0;
    let failedEmails = 0;

    for (const follower of followers) {

      // Trace puede reenviar el mismo evento.
      if (
        eventId &&
        follower.last_event_id === eventId
      ) {
        console.log(
          "Evento duplicado ignorado:",
          eventId
        );

        continue;
      }

      const statusChanged =
        status &&
        follower.current_status !== status;

      const checkpointChanged =
        latestMessage &&
        follower.last_checkpoint !==
          latestMessage;

      if (
        !statusChanged &&
        !checkpointChanged
      ) {
        continue;
      }

      // Obtener email desde Supabase Auth
      const userResponse =
        await fetch(
          `${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(
            follower.user_id
          )}`,
          {
            headers: {
              apikey: supabaseSecret,
              Authorization:
                `Bearer ${supabaseSecret}`
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

      const userData =
        await userResponse.json();

      const user =
        userData.user || userData;

      const email =
        user.email;

      if (!email) {
        console.log(
          "Usuario sin email:",
          follower.user_id
        );

        continue;
      }

      const friendlyStatus =
        statusRaw === "customs"
          ? "En aduana"
          : (
              statusNames[status] ||
              "Nueva actualización"
            );

      let subject =
        `Actualización de tu envío: ${friendlyStatus}`;

      if (status === "OutForDelivery") {
        subject =
          "Tu paquete está en reparto";
      }

      if (status === "Delivered") {
        subject =
          "Tu paquete fue entregado";
      }

      if (status === "Exception") {
        subject =
          "Tu envío requiere atención";
      }

      const referenceHTML =
        follower.reference_name
          ? `
            <p style="
              margin:0 0 8px;
              font-size:14px;
              color:#64748B;
            ">
              Referencia:
              <strong>
                ${escapeHtml(
                  follower.reference_name
                )}
              </strong>
            </p>
          `
          : "";

      const emailResponse =
        await fetch(
          "https://api.resend.com/emails",
          {
            method: "POST",
            headers: {
              Authorization:
                `Bearer ${resendKey}`,

              "Content-Type":
                "application/json",

              "Idempotency-Key":
                `packping-trace-${eventId || Date.now()}-${follower.user_id}`
            },

            body: JSON.stringify({
              from:
                "PackPing <onboarding@resend.dev>",

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

                  <img
                    src="https://pack-ping.vercel.app/logo-email.png"
                    alt="PackPing"
                    width="150"
                    style="
                      display:block;
                      width:150px;
                      height:auto;
                      border:0;
                      margin-bottom:28px;
                    "
                  >

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
                    Hay novedades en uno de los envíos
                    que estás siguiendo.
                  </p>

                  <div style="
                    background:#F7F9FC;
                    border:1px solid #E2E8F0;
                    border-radius:16px;
                    padding:22px;
                    margin-bottom:24px;
                  ">

                    ${referenceHTML}

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
                      ${escapeHtml(
                        trackingNumber
                      )}
                    </p>

                    <p style="
                      margin:0 0 8px;
                      font-size:23px;
                      font-weight:700;
                      color:#0f2040;
                    ">
                      ${escapeHtml(
                        friendlyStatus
                      )}
                    </p>

                    <p style="
                      margin:0;
                      font-size:16px;
                      color:#334155;
                    ">
                      ${escapeHtml(
                        latestMessage
                      )}
                    </p>

                    ${
                      location
                        ? `
                          <p style="
                            margin:14px 0 0;
                            color:#64748B;
                            font-size:14px;
                          ">
                            📍 ${escapeHtml(
                              location
                            )}
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
                    Recibís este correo porque
                    activaste la campana para este
                    envío en PackPing.
                  </p>

                </div>
              `
            })
          }
        );

      if (!emailResponse.ok) {
        console.error(
          "Resend no pudo enviar:",
          await emailResponse.text()
        );

        failedEmails += 1;
        continue;
      }

      const emailData =
        await emailResponse.json();

      console.log(
        "Email Trace enviado:",
        {
          trackingNumber,
          email_id: emailData.id
        }
      );

      emailsSent += 1;

      // Guardar evento procesado
      const updateResponse =
        await fetch(
          `${supabaseUrl}/rest/v1/followed_shipments?id=eq.${encodeURIComponent(
            follower.id
          )}`,
          {
            method: "PATCH",

            headers: {
              apikey: supabaseSecret,

              Authorization:
                `Bearer ${supabaseSecret}`,

              "Content-Type":
                "application/json",

              Prefer:
                "return=minimal"
            },

            body: JSON.stringify({
              current_status:
                status || null,

              last_checkpoint:
                latestMessage || null,

              last_event_id:
                eventId || null,

              notifications_enabled:
                status === "Delivered"
                  ? false
                  : true,

              updated_at:
                new Date().toISOString()
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

    // Si Resend falló para alguien,
    // devolvemos error para que Trace reintente.
    if (failedEmails > 0) {
      return Response.json(
        {
          ok: false,
          error:
            "Uno o más correos no pudieron enviarse",
          emails_sent: emailsSent,
          emails_failed: failedEmails
        },
        {
          status: 500
        }
      );
    }

    return Response.json({
      ok: true,
      received: true,
      event_id: eventId,
      event_type: eventType,
      tracking_number: trackingNumber,
      followers: followers.length,
      emails_sent: emailsSent
    });

  } catch (error) {
    console.error(
      "Error procesando Trace webhook:",
      error
    );

    return Response.json(
      {
        ok: false,
        error:
          "Error procesando webhook"
      },
      {
        status: 500
      }
    );
  }
}
