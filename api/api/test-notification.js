module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Método no permitido"
    });
  }

  const testSecret = process.env.PACKPING_TEST_SECRET;
  const receivedSecret = req.headers["x-packping-test-secret"];

  if (
    !testSecret ||
    receivedSecret !== testSecret
  ) {
    return res.status(401).json({
      ok: false,
      error: "No autorizado"
    });
  }

  const {
    trackingNumber = "RR553733810UY"
  } = req.body || {};

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
      error: "Faltan variables de entorno"
    });
  }

  try {
    const followersResponse = await fetch(
      `${supabaseUrl}/rest/v1/followed_shipments` +
      `?tracking_number=eq.${encodeURIComponent(trackingNumber)}` +
      `&select=id,user_id,tracking_number,reference_name`,
      {
        headers: {
          apikey: supabaseSecret,
          Authorization: `Bearer ${supabaseSecret}`
        }
      }
    );

    const followers =
      await followersResponse.json();

    if (
      !followersResponse.ok ||
      !followers.length
    ) {
      return res.status(404).json({
        ok: false,
        error: "No encontramos un usuario siguiendo ese envío"
      });
    }

    const follower = followers[0];

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

    const userData =
      await userResponse.json();

    const user =
      userData.user || userData;

    if (!user?.email) {
      return res.status(404).json({
        ok: false,
        error: "El usuario no tiene email"
      });
    }

    const emailResponse = await fetch(
      "https://api.resend.com/emails",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from:
            "PackPing <onboarding@resend.dev>",

          to: [user.email],

          subject:
            "📦 Prueba de notificación PackPing",

          html: `
            <div style="
              font-family:Arial,sans-serif;
              max-width:560px;
              margin:auto;
              padding:32px;
            ">
              <h2>
                ✅ Las notificaciones de PackPing funcionan
              </h2>

              <p>
                Esta es una prueba del sistema automático
                de avisos.
              </p>

              <p>
                <strong>Envío:</strong>
                ${trackingNumber}
              </p>

              ${
                follower.reference_name
                  ? `
                    <p>
                      <strong>Referencia:</strong>
                      ${follower.reference_name}
                    </p>
                  `
                  : ""
              }

              <p>
                Si estás viendo este correo,
                Supabase + Resend están correctamente
                conectados.
              </p>
            </div>
          `
        })
      }
    );

    const emailData =
      await emailResponse.json();

    if (!emailResponse.ok) {
      return res.status(500).json({
        ok: false,
        error: "Resend rechazó el correo",
        details: emailData
      });
    }

    return res.status(200).json({
      ok: true,
      email_sent: true,
      tracking_number: trackingNumber,
      resend_id: emailData.id
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      ok: false,
      error: "Error enviando notificación de prueba"
    });
  }
};
