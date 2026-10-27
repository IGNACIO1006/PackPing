function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function normalizeText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function getCorreoStatus(message = "", deliveryStage = "") {
  const text = normalizeText(
    `${message} ${deliveryStage}`
  );

  if (
    /ENTREGADO|ENTREGADA|ENTREGA AL DESTINATARIO/.test(text)
  ) {
    return "Entregado";
  }

  if (
    /DEVUELTO|RECHAZADO|NO ENTREGADO|INTENTO FALLIDO|INCIDENCIA/.test(text)
  ) {
    return "Atención";
  }

  return "En tránsito";
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Método no permitido"
    });
  }

  const expectedSecret =
    process.env.CORREO_CRON_SECRET;

  const receivedSecret =
    req.headers.authorization;

  if (
    !expectedSecret ||
    receivedSecret !== `Bearer ${expectedSecret}`
  ) {
    return res.status(401).json({
      ok: false,
      error: "No autorizado"
    });
  }

  const supabaseUrl =
    process.env.SUPABASE_URL;

  const supabaseSecret =
    process.env.SUPABASE_SECRET_KEY;

  const resendKey =
    process.env.RESEND_API_KEY;

  if (
    !supabaseUrl ||
    !supabaseSecret ||
    !resendKey
  ) {
    return res.status(500).json({
      ok: false,
      error: "Configuración incompleta"
    });
  }

  try {
    const followersResponse = await fetch(
      `${supabaseUrl}/rest/v1/followed_shipments` +
      `?notifications_enabled=eq.true` +
      `&select=id,user_id,tracking_number,carrier,reference_name,current_status,last_checkpoint,last_event_id`,
      {
        headers: {
          apikey: supabaseSecret,
          Authorization:
            `Bearer ${supabaseSecret}`
        }
      }
    );

    if (!followersResponse.ok) {
      return res.status(500).json({
        ok: false,
        error: "No pudimos consultar Supabase"
      });
    }

    const allFollowers =
      await followersResponse.json();

    const followers =
      allFollowers.filter(item =>
        String(item.carrier || "")
          .toLowerCase()
          .includes("correo")
      );

    let checked = 0;
    let changes = 0;
    let emailsSent = 0;

    for (const follower of followers) {
      checked += 1;

      const trackingNumber =
        String(follower.tracking_number || "")
          .trim()
          .toUpperCase();

      const correoUrl =
        "https://ahiva.correo.com.uy/" +
        "servicioConsultaTntIps-ws/" +
        "seguimientoEnvios/eventosweb" +
        "?codigoPieza=" +
        encodeURIComponent(trackingNumber);

      const correoResponse =
        await fetch(correoUrl, {
          headers: {
            Accept: "application/json"
          }
        });

      if (!correoResponse.ok) {
        console.error(
          "Correo Uruguayo no respondió:",
          trackingNumber,
          correoResponse.status
        );
        continue;
      }

      const correoData =
        await correoResponse.json();

      const shipment =
        Array.isArray(correoData)
          ? correoData[0]
          : correoData;

      if (
        !shipment ||
        shipment.estado === "NOT_FOUND"
      ) {
        continue;
      }

      const events =
        Array.isArray(shipment.eventos)
          ? shipment.eventos
          : [];

      if (!events.length) {
        continue;
      }

      const latestEvent =
        events[0];

      const latestMessage =
        latestEvent.evento ||
        "Nueva actualización";

      const latestLocation =
        latestEvent.ubicacion || "";

      const latestDate =
        latestEvent.fecha || "";

      const eventCode =
        latestEvent.codigoevento || "";

      const syntheticEventId =
        [
          "correo",
          trackingNumber,
          eventCode,
          latestDate,
          latestMessage
        ].join(":");

      // No hubo cambios.
      if (
        follower.last_event_id ===
          syntheticEventId ||
        (
          follower.last_checkpoint ===
            latestMessage &&
          !follower.last_event_id
        )
      ) {
        continue;
      }

      changes += 1;

      const currentStatus =
        getCorreoStatus(
          latestMessage,
          shipment.codigoEtapaEntrega
        );

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
        continue;
      }

      const userData =
        await userResponse.json();

      const user =
        userData.user || userData;

      if (!user?.email) {
        continue;
      }

      let subject =
        `Actualización de tu envío: ${currentStatus}`;

      if (currentStatus === "Entregado") {
        subject =
          "Tu paquete fue entregado";
      }

      if (currentStatus === "Atención") {
        subject =
          "Tu envío requiere atención";
      }

      if (
        /ASIGNADO A DISTRIBUCION|SALIDA A REPARTO/.test(
          normalizeText(latestMessage)
        )
      ) {
        subject =
          "Tu paquete está en reparto";
      }

      const referenceHTML =
        follower.reference_name
          ? `
            <p style="color:#64748B;">
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
                `packping-correo-${syntheticEventId}-${follower.user_id}`
            },
            body: JSON.stringify({
              from:
                "PackPing <onboarding@resend.dev>",

              to: [user.email],

              subject,

              html: `
                <div style="
                  font-family:Arial,sans-serif;
                  max-width:560px;
                  margin:auto;
                  padding:30px 20px;
                  color:#0f2040;
                ">

                  <img
                    src="https://pack-ping.vercel.app/logo-email.png"
                    alt="PackPing"
                    width="150"
                    style="
                      display:block;
                      margin-bottom:28px;
                    "
                  >

                  <h2>
                    Tu envío tiene una nueva actualización
                  </h2>

                  ${referenceHTML}

                  <div style="
                    background:#F7F9FC;
                    border:1px solid #E2E8F0;
                    border-radius:16px;
                    padding:22px;
                  ">

                    <strong>
                      Correo Uruguayo
                    </strong>

                    <p>
                      ${escapeHtml(trackingNumber)}
                    </p>

                    <h3>
                      ${escapeHtml(currentStatus)}
                    </h3>

                    <p>
                      ${escapeHtml(latestMessage)}
                    </p>

                    ${
                      latestLocation
                        ? `
                          <p>
                            📍 ${escapeHtml(
                              latestLocation
                            )}
                          </p>
                        `
                        : ""
                    }

                    ${
                      latestDate
                        ? `
                          <p>
                            🕒 ${escapeHtml(
                              latestDate
                            )}
                          </p>
                        `
                        : ""
                    }

                  </div>

                  <p style="margin-top:24px;">
                    <a
                      href="https://pack-ping.vercel.app/"
                      style="
                        background:#2F66E8;
                        color:white;
                        padding:14px 22px;
                        border-radius:10px;
                        text-decoration:none;
                        font-weight:bold;
                      "
                    >
                      Ver en PackPing
                    </a>
                  </p>

                </div>
              `
            })
          }
        );

      if (!emailResponse.ok) {
        console.error(
          "Error Resend:",
          await emailResponse.text()
        );
        continue;
      }

      emailsSent += 1;

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
              currentStatus,

            last_checkpoint:
              latestMessage,

            last_event_id:
              syntheticEventId,

            notifications_enabled:
              currentStatus === "Entregado"
                ? false
                : true,

            updated_at:
              new Date().toISOString()
          })
        }
      );
    }

    return res.status(200).json({
      ok: true,
      checked,
      changes,
      emails_sent: emailsSent
    });

  } catch (error) {
    console.error(
      "Error cron Correo Uruguayo:",
      error
    );

    return res.status(500).json({
      ok: false,
      error:
        "Error revisando Correo Uruguayo"
    });
  }
};
