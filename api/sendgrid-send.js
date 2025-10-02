// /api/sendgrid-send.js
// Sends email via SendGrid and embeds your logo as an inline CID image.

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body =
      (typeof req.body === "object" && req.body) ||
      (await req.json?.()) ||
      {};

    const {
      to,
      from,
      replyTo,
      subject,     // used only for raw HTML path
      text,        // used only for raw HTML path
      html,        // used only for raw HTML path
      templateId,  // if present we use Dynamic Template
      dynamicData = {},
    } = body;

    if (!to || !from) return res.status(400).json({ error: "Missing 'to' or 'from'." });

    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SENDGRID_API_KEY not set" });

    // --- Always fetch the public logo and attach inline as CID ---
    const publicLogoUrl = process.env.LOGO_URL || "https://invoice-remind.vercel.app/logo.png";
    let inlineLogoAttachment = null;
    try {
      const r = await fetch(publicLogoUrl);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        inlineLogoAttachment = {
          content: buf.toString("base64"),
          filename: "logo.png",
          type: r.headers.get("content-type") || "image/png",
          disposition: "inline",
          content_id: "logo", // use src="cid:logo"
        };
      }
    } catch (e) {
      // If the fetch fails, we just skip the inline logo
      // console.warn("Failed to fetch logo for CID:", e);
    }

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    const base = {
      from: { email: from },
      ...(replyTo ? { reply_to: { email: replyTo } } : {}),
      ...(inlineLogoAttachment ? { attachments: [inlineLogoAttachment] } : {}),
    };

    const payload = templateId
      ? {
          ...base,
          personalizations: [{ to: [{ email: to }], dynamic_template_data: dynamicData }],
          template_id: templateId,
        }
      : {
          ...base,
          personalizations: [{ to: [{ email: to }], ...(subject ? { subject } : {}) }],
          content: [
            ...(text ? [{ type: "text/plain", value: text }] : []),
            ...(html ? [{ type: "text/html", value: html }] : []),
          ],
        };

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
      usingTemplate: Boolean(templateId),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}
