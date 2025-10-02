// /api/sendgrid-send.js
import fs from "fs";
import path from "path";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body =
      (typeof req.body === "object" && req.body) ||
      (await req.json?.()) ||
      {};

    const { to, from, replyTo, subject, text, html, templateId, dynamicData = {} } = body;

    if (!to || !from) {
      return res.status(400).json({ error: "Missing 'to' or 'from'." });
    }

    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "SENDGRID_API_KEY not set" });
    }

    // ---- Read logo and attach inline ----
    let inlineLogoAttachment = null;
    try {
      const logoPath = path.join(process.cwd(), "public", "logo.png");
      const logoBase64 = fs.readFileSync(logoPath).toString("base64");
      inlineLogoAttachment = {
        content: logoBase64,
        filename: "logo.png",
        type: "image/png",
        disposition: "inline",
        content_id: "logo", // <-- reference in HTML with src="cid:logo"
      };
    } catch (err) {
      console.error("Logo not found in /public/logo.png", err);
    }

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    let payload;
    if (templateId) {
      payload = {
        from: { email: from },
        personalizations: [
          { to: [{ email: to }], dynamic_template_data: dynamicData },
        ],
        template_id: templateId,
        ...(replyTo ? { reply_to: { email: replyTo } } : {}),
        ...(inlineLogoAttachment ? { attachments: [inlineLogoAttachment] } : {}),
      };
    } else {
      const content = [];
      if (text) content.push({ type: "text/plain", value: text });
      if (html) content.push({ type: "text/html", value: html });

      payload = {
        from: { email: from },
        personalizations: [
          { to: [{ email: to }], ...(subject ? { subject } : {}) },
        ],
        ...(replyTo ? { reply_to: { email: replyTo } } : {}),
        ...(content.length ? { content } : {}),
        ...(inlineLogoAttachment ? { attachments: [inlineLogoAttachment] } : {}),
      };
    }

    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      const errTxt = await resp.text();
      return res.status(resp.status).json({ error: errTxt });
    }

    return res.status(200).json({
      ok: true,
      inlineLogoAttached: Boolean(inlineLogoAttachment),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}
