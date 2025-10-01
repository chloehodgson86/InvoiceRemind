// /api/sendgrid-send.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Works on Vercel (req.body) and web-standards (req.json)
    const body = (typeof req.body === "object" && req.body) || (await req.json?.()) || {};
    const { to, subject, text, html, from, replyTo } = body;

    if (!to || !subject || (!text && !html)) {
      return res.status(400).json({ error: "Missing to/subject and either text or html" });
    }

    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SENDGRID_API_KEY not set" });

    const fromEmail = from || process.env.SENDGRID_FROM || "no-reply@example.com";

    // Build multipart/alternative (text + html)
    const content = [];
    if (text) content.push({ type: "text/plain", value: text });
    if (html) content.push({ type: "text/html", value: html });

    const payload = {
      personalizations: [{ to: [{ email: to }] }],
      from: { email: fromEmail, name: "Paramount Liquor Accounts" },
      subject,
      content,
      ...(replyTo ? { reply_to: { email: replyTo } } : {}),
    };

    const sgRes = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const messageId = sgRes.headers.get?.("x-message-id") || null;

    if (!sgRes.ok) {
      const errText = await sgRes.text().catch(() => "");
      return res.status(sgRes.status).json({ ok: false, messageId, error: errText || "SendGrid error" });
    }

    return res.status(200).json({ ok: true, messageId, sentHtml: !!html });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unexpected error" });
  }
}

