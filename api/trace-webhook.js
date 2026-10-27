import crypto from "node:crypto";

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

  if (timestamps.length !== 1) {
    return false;
  }

  const timestamp = timestamps[0];

  if (!/^\d+$/.test(timestamp)) {
    return false;
  }

  if (timestampHeader !== timestamp) {
    return false;
  }

  const ageSeconds =
    Math.abs(Date.now() / 1000 - Number(timestamp));

  if (ageSeconds > 300) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest();

  const signatures = parts
    .filter(([key]) => key === "v1")
    .map(([, value]) => value);

  for (const signature of signatures) {
    if (!/^[a-f0-9]{64}$/i.test(signature || "")) {
      continue;
    }

    const received = Buffer.from(signature, "hex");

    if (
      received.length === expected.length &&
      crypto.timingSafeEqual(received, expected)
    ) {
      return true;
    }
  }

  return false;
}

export function GET() {
  return Response.json({
    ok: true,
    service: "PackPing Trace Webhook"
  });
}

export async function POST(request) {
  const secret =
    process.env.TRACE_WEBHOOK_SECRET;

  if (!secret) {
    return Response.json(
      {
        ok: false,
        error: "TRACE_WEBHOOK_SECRET no configurado"
      },
      {
        status: 500
      }
    );
  }

  // IMPORTANTE:
  // leer el cuerpo crudo ANTES de convertirlo a JSON.
  const rawBody = await request.text();

  const validSignature =
    verifyTraceWebhook(
      rawBody,
      request.headers,
      secret
    );

  if (!validSignature) {
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

  console.log("TRACE WEBHOOK OK", {
    eventId,
    eventType,
    trackingNumber:
      payload?.tracking?.tracking_number || null,
    status:
      payload?.tracking?.status || null
  });

  return Response.json({
    ok: true,
    received: true,
    event_id: eventId,
    event_type: eventType
  });
}
