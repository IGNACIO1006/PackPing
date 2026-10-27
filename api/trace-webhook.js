import crypto from "node:crypto";

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function verifyTraceWebhook(rawBody, headers, secret) {
  const signatureHeader =
    headers.get("trace-signature") || "";

  const timestampHeader =
    headers.get("trace-timestamp") || "";

  const parts = signatureHeader
    .split(",")
    .map(part => part.split("="));

  const timestamps = parts
    .filter(([key]) => key === "t")
    .map(([, value]) => value);

  if (timestamps.length !== 1) return false;

  const timestamp = timestamps[0];

  if (!/^\d+$/.test(timestamp)) return false;
  if (timestampHeader !== timestamp) return false;

  const ageSeconds =
    Math.abs(Date.now() / 1000 - Number(timestamp));

  if (ageSeconds > 300) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest();

  const signatures = parts
    .filter(([key]) => key === "v1")
    .map(([, value]) => value);

  return signatures.some(signature => {
    if (!/^[a-f0-9]{64}$/i.test(signature || "")) {
      return false;
    }

    const received =
      Buffer.from(signature, "hex");

    return (
      received.length === expected.length &&
      crypto.timingSafeEqual(received, expected)
    );
  });
}

function traceStatusToPackPing(status) {
  switch (String(status || "").toLowerCase()) {
    case "pending":
      return "Pending";

    case "out_for_delivery":
      return "OutForDelivery";

    case "delivered":
      return "Delivered";

    case "exception":
      return "Exception";

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

export function GET() {
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

  if (
    !verifyTraceWebhook(
      rawBody,
      request.headers,
      webhookSecret
    )
  ) {
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
    request.headers.get("trace-event") ||
    payload.event_type ||
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
      followers: 0,
      emails_sent: 0
    });
  }

  const status =
    traceStatusToPackPing(
      tracking.status
    );

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
          ok: false,
          error:
            "Error consultando seguidores"
        },
        {
          status: 500
        }
      );
    }

    const followers =
      await followersResponse.json();

    let emailsSent = 0;

    for (const follower of followers) {

      // Evita mails duplicados si Trace reintenta.
      if (
        eventId &&
        follower.last_event_id === eventId
      ) {
        continue;
      }

      const statusChanged =
        follower.current_status !== status;

      const checkpointChanged =
        follower.last_checkpoint !==
        latestMessage;

      if (
        !statusChanged &&
        !checkpointChanged
      ) {
        continue;
      }

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
          "No se pudo obtener usuario:",
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

      if (!email) continue;

      const friendlyStatus =
        String(tracking.status)
          .toLowerCase() === "customs"
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
              color:#64748B;
              font-size:14px;
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

      const stableEventId =
        eventId ||
        `${trackingNumber}-${status}-${latestEvent?.id || latestEvent?.timestamp || "update"}`;

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
                `packping-trace-${stableEventId}-${follower.user_id}`
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
                      margin-bottom:28px;
                    "
                  >

                  <h2 style="
                    margin:0 0 10px;
                    font-size:24px;
                  ">
                    Tu envío tiene una nueva actualización
                  </h2>

                  <p style="
                    margin:0 0 24px;
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
                      font-weight:700;
                    ">
                      ${escapeHtml(carrier)}
                    </p>

                    <p style="
                      margin:0 0 18px;
                      color:#64748B;
                    ">
                      ${escapeHtml(
                        trackingNumber
                      )}
                    </p>

                    <p style="
                      margin:0 0 8px;
                      font-size:23px;
                      font-weight:700;
                    ">
                      ${escapeHtml(
                        friendlyStatus
                      )}
                    </p>

                    <p style="
                      margin:0;
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
                      color:white;
                      text-decoration:none;
                      padding:14px 24px;
                      border-radius:10px;
                      font-weight:700;
                    "
                  >
                    Ver en PackPing
                  </a>

                  <p style="
                    margin-top:28px;
                    color:#94A3B8;
                    font-size:12px;
                  ">
                    Recibís este correo porque activaste
                    la campana para este envío en PackPing.
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

        // Trace volverá a intentar el webhook.
        return Response.json(
          {
            ok: false,
            error:
              "No se pudo enviar el correo"
          },
          {
            status: 500
          }
        );
      }

      emailsSent += 1;

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
                status,

              last_checkpoint:
                latestMessage,

              last_event_id:
                stableEventId,

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
          "No se pudo actualizar Supabase:",
          await updateResponse.text()
        );
      }
    }

    return Response.json({
      ok: true,
      received: true,
      tracking_number:
        trackingNumber,
      followers:
        followers.length,
      emails_sent:
        emailsSent
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
