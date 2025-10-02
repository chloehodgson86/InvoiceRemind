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
      subject = "Overdue Invoice Reminder",
      customerName,
      overdueRows = [],
      creditRows = [],
      totalOverdue = "",
      totalCredits = "",
      netPayable = "",
      templateId = "d-c32e5033436a4186a760c43071a0a103", // your template ID
    } = body;

    if (!to || !from) return res.status(400).json({ error: "Missing 'to' or 'from'." });

    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SENDGRID_API_KEY not set" });

    /* ---------------- Build invoice rows HTML ---------------- */
    const invoiceRows = overdueRows.map(r => `
      <tr>
        <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${r.inv}</td>
        <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${typeof r.amt === "number" ? `$${r.amt.toFixed(2)}` : r.amt}</td>
        <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${r.due}</td>
      </tr>
    `).join("") || `<tr><td colspan="3" style="padding:10px;">(none)</td></tr>`;

    /* ---------------- Build credits section (optional) ---------------- */
    let creditSection = "";
    if (creditRows.length) {
      creditSection = `
        <h3 style="margin:24px 0 8px 0;font-size:16px;color:#0f172a;">Unapplied credits</h3>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <thead>
            <tr style="background:#f8fafc;">
              <th align="left" style="padding:10px;font-size:12px;color:#475569;">Reference</th>
              <th align="right" style="padding:10px;font-size:12px;color:#475569;">Amount</th>
              <th align="right" style="padding:10px;font-size:12px;color:#475569;">Date</th>
            </tr>
          </thead>
          <tbody>
            ${creditRows.map(cr => `
              <tr>
                <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${cr.ref}</td>
                <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${typeof cr.amt === "number" ? `$${cr.amt.toFixed(2)}` : cr.amt}</td>
                <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${cr.date}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      `;
    }

    /* ---------------- Mailto link ---------------- */
    const replyHref = replyTo
      ? `mailto:${encodeURIComponent(replyTo)}?subject=${encodeURIComponent(subject)}`
      : "#";

    /* ---------------- Attach logo inline (CID) ---------------- */
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
          content_id: "logo", // src="cid:logo" in your template
        };
      }
    } catch (e) {
      console.warn("⚠️ Failed to fetch logo:", e.message);
    }

    /* ---------------- Build payload ---------------- */
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    const base = {
      from: { email: from },
      ...(replyTo ? { reply_to: { email: replyTo } } : {}),
      ...(inlineLogoAttachment ? { attachments: [inlineLogoAttachment] } : {}),
    };

    const payload = {
      ...base,
      personalizations: [{
        to: [{ email: to }],
        dynamic_template_data: {
          customerName,
          invoiceRows,
          totalOverdue,
          totalCredits,
          netPayable,
          creditSection,
          replyHref,
          year: new Date().getFullYear(),
        },
      }],
      template_id: templateId,
    };

    /* ---------------- Send to SendGrid ---------------- */
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
      usingTemplate: true,
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}

