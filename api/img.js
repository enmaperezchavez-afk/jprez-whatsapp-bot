// ============================================
// PROXY DE IMAGENES - Constructora JPREZ
// Sirve imagenes desde Google Drive via URL directa
// para que WhatsApp las acepte sin redirect ni HTML.
// Mismo enfoque que /api/pdf pero default a image/jpeg.
// ============================================

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).send("Method Not Allowed");
  }

  const { id } = req.query;

  if (!id) {
    return res.status(400).send("Missing file ID parameter");
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    return res.status(400).send("Invalid file ID format");
  }

  try {
    const downloadUrl =
      "https://drive.usercontent.google.com/download?id=" +
      id +
      "&export=download&confirm=t";

    console.log("Proxy IMG - Fetching file ID: " + id);

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

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await response.arrayBuffer());

    const bufferStart = buffer.slice(0, 200).toString("utf-8").toLowerCase();
    const isHtml =
      contentType.includes("text/html") ||
      bufferStart.includes("<!doctype") ||
      bufferStart.includes("<html");

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
          altResponse.headers.get("content-type") || "image/jpeg";
        const altBuffer = Buffer.from(await altResponse.arrayBuffer());

        const altStart = altBuffer.slice(0, 200).toString("utf-8").toLowerCase();
        const altIsHtml =
          altContentType.includes("text/html") ||
          altStart.includes("<!doctype") ||
          altStart.includes("<html");

        if (!altIsHtml) {
          res.setHeader("Content-Type", altContentType);
          res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
          return res.send(altBuffer);
        }
      }

      console.error("Ambas URLs retornaron HTML para file ID: " + id);
      return res.status(502).send("Could not fetch image from Google Drive - file may not be shared publicly");
    }

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
    return res.send(buffer);
  } catch (error) {
    console.error("Error en proxy IMG:", error.message);
    return res.status(500).send("Internal server error");
  }
};
