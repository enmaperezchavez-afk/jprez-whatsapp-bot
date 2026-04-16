// ============================================
// PROXY DE PDFs - Constructora JPREZ
// Resuelve el problema de Google Drive
// que retorna HTML en vez del PDF real.
// WhatsApp necesita una URL directa al archivo.
// ============================================

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).send("Method Not Allowed");
  }

  const { id } = req.query;

  if (!id) {
    return res.status(400).send("Missing file ID parameter");
  }

  // Validar que el ID tenga formato de Google Drive (letras, numeros, guiones, guion bajo)
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return res.status(400).send("Invalid file ID format");
  }

  try {
    // Usar el formato que bypasea la pagina de confirmacion de Google Drive
    const downloadUrl =
      "https://drive.usercontent.google.com/download?id=" +
      id +
      "&export=download&confirm=t";

    console.log("Proxy PDF - Fetching file ID: " + id);

    const response = await fetch(downloadUrl, {
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
    });

    if (!response.ok) {
      console.error("Error fetching from Google Drive: " + response.status);
      return res.status(502).send("Error fetching file from Google Drive");
    }

    const contentType = response.headers.get("content-type") || "application/pdf";
    const buffer = Buffer.from(await response.arrayBuffer());

    // Detectar HTML por content-type O por contenido real (sin limite de tamano)
    const bufferStart = buffer.slice(0, 200).toString("utf-8").toLowerCase();
    const isHtml =
      contentType.includes("text/html") ||
      bufferStart.includes("<!doctype") ||
      bufferStart.includes("<html");

    // Si Google Drive devolvio HTML en vez del PDF, intentar otra URL
    if (isHtml) {
      console.log("Google Drive retorno HTML (" + buffer.length + " bytes), intentando URL alternativa...");

      const altUrl =
        "https://drive.google.com/uc?export=download&confirm=t&id=" + id;

      const altResponse = await fetch(altUrl, {
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });

      if (altResponse.ok) {
        const altContentType =
          altResponse.headers.get("content-type") || "application/pdf";
        const altBuffer = Buffer.from(await altResponse.arrayBuffer());

        // Verificar que ahora si es un archivo real (no HTML)
        const altStart = altBuffer.slice(0, 200).toString("utf-8").toLowerCase();
        const altIsHtml =
          altContentType.includes("text/html") ||
          altStart.includes("<!doctype") ||
          altStart.includes("<html");

        if (!altIsHtml) {
          res.setHeader("Content-Type", altContentType);
          res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
          return res.send(altBuffer);
        }
      }

      // Si ambos intentos retornan HTML, devolver error
      console.error("Ambas URLs retornaron HTML para file ID: " + id);
      return res.status(502).send("Could not fetch PDF from Google Drive - file may not be shared publicly");
    }

    // Exito - enviar el archivo
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
    return res.send(buffer);
  } catch (error) {
    console.error("Error en proxy PDF:", error.message);
    return res.status(500).send("Internal server error");
  }
};
