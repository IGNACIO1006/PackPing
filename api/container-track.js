module.exports = async function handler(req, res) {

  // Comprobación rápida desde el navegador
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "PackPing ShipsGo Container Tracking"
    });
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      ok: false,
      error: "Método no permitido"
    });
  }

  try {

    const apiKey = process.env.SHIPSGO_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        ok: false,
        error: "SHIPSGO_API_KEY no está configurada"
      });
    }

    const {
      containerNumber,
      shippingLine = "OTHERS"
    } = req.body || {};

    const container = String(containerNumber || "")
      .trim()
      .toUpperCase()
      .replace(/\s+/g, "");

    if (!container) {
      return res.status(400).json({
        ok: false,
        error: "Ingresá un número de contenedor"
      });
    }

    // Formato ISO habitual: 4 letras + 7 números
    if (!/^[A-Z]{4}[0-9]{7}$/.test(container)) {
      return res.status(400).json({
        ok: false,
        error: "El número de contenedor debe tener 4 letras y 7 números"
      });
    }


    // 1. Primero intentamos obtener un seguimiento ya existente
    const getUrl = new URL(
      "https://shipsgo.com/api/v1.2/ContainerService/GetContainerInfo/"
    );

    getUrl.searchParams.set("authCode", apiKey);
    getUrl.searchParams.set("requestId", container);
    getUrl.searchParams.set("mapPoint", "true");

    const existingResponse = await fetch(getUrl.toString());

    const existingText = await existingResponse.text();

    let existingData;

    try {
      existingData = JSON.parse(existingText);
    } catch {
      existingData = existingText;
    }


    // Si ShipsGo ya tiene datos válidos, los devolvemos
    const existingCheck = String(
      typeof existingData === "string"
        ? existingData
        : JSON.stringify(existingData)
    ).toLowerCase();

    const looksLikeError =
      existingCheck.includes("error") ||
      existingCheck.includes("not found") ||
      existingCheck.includes("does not exist") ||
      existingCheck.includes("no data");


    if (existingResponse.ok && !looksLikeError) {

      return res.status(200).json({
        ok: true,
        created: false,
        containerNumber: container,
        data: existingData
      });

    }


    // 2. Si todavía no existe, creamos el tracking en ShipsGo
    const body = new URLSearchParams();

    body.set("authCode", apiKey);
    body.set("containerNumber", container);
    body.set(
      "shippingLine",
      String(shippingLine || "OTHERS").trim() || "OTHERS"
    );

    body.set("tags", "PackPing");


    const createResponse = await fetch(
      "https://shipsgo.com/api/v1.2/ContainerService/PostContainerInfo",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      }
    );


    const createText = await createResponse.text();

    let createData;

    try {
      createData = JSON.parse(createText);
    } catch {
      createData = createText;
    }


    if (!createResponse.ok) {

      console.error("ShipsGo error:", createData);

      return res.status(502).json({
        ok: false,
        error: "ShipsGo no pudo iniciar el seguimiento",
        details: createData
      });

    }


    return res.status(200).json({
      ok: true,
      created: true,
      processing: true,
      containerNumber: container,
      message:
        "El contenedor fue agregado a ShipsGo. La información puede tardar unos minutos en estar disponible.",
      data: createData
    });


  } catch (error) {

    console.error("Container tracking error:", error);

    return res.status(500).json({
      ok: false,
      error: "No pudimos consultar el contenedor"
    });

  }
};
