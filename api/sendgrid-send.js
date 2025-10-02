// /api/sendgrid-send.js
// Sends via SendGrid using a Dynamic Template. Auto-builds dynamic_template_data
// (invoiceRows, creditSection, totals) and attaches an inline CID logo.

function money(value) {
  if (value == null) return "";
  if (typeof value === "number") {
    return value.toLocaleString(undefined, { style: "currency", currency: "AUD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return String(value);
}

function buildInvoiceRows(overdueRows = []) {
  if (!Array.isArray(overdueRows) || overdueRows.length === 0) {
    return `<tr><td colspan="3" style="padding:10px;border-bottom:1px solid #e5e7eb;">(none)</td></tr>`;
  }
  return overdueRows.map(r => {
    const inv = r.inv ?? r.invoice ?? "";
    const amt = money(r.amt ?? r.amount);
    const due = r.due ?? r.dueDate ?? "";
    return `
      <tr>
        <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${inv}</td>
        <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${amt}</td>
        <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${due}</td>
      </tr>
    `;
  }).join("");
}

function buildCreditSection(creditRows = []) {
  if (!Array.isArray(creditRows) || creditRows.length === 0) return "";
  const rows = creditRows.map(cr => {
    const ref = cr.ref ?? cr.reference ?? "";
    const amt = money(cr.amt ?? cr.amount);
    const date = cr.date ?? cr.dueDate ?? "";
    return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">${ref}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${amt}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${date}</td>
      </tr>
    `;
  }).join("");

  return `
    <h3 style="margin:24px 0 8px 0;font-size:16px;color:#0f172a;">Unapplied credits</h3>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:#f8fafc;">
          <th align="left" style="padding:10px 12px;font-size:12px;color:#475569;">Reference</th>
          <th align="right" style="padding:10px 12px;font-size:12px;color:#475569;">Amount</th>
          <th align="right" style="padding:10px 12px;font-size:12px;color:#475569;">Date</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>
  `;
}

function buildDynamicData(body) {
  const dd = { ...(body.dynamicData || {}) };

  if (!dd.invoiceRows) dd.invoiceRows = buildInvoiceRows(body.overdueRows);
  if (!dd.creditSection) dd.creditSection = buildCreditSection(body.creditRows);

  if (dd.totalOverdue == null && body.totalOverdue != null) dd.totalOverdue = money(body.totalOverdue);
  if (dd.totalCredits == null && body.totalCredits != null) dd.totalCredits = money(body.totalCredits);
  if (dd.netPayable == null && body.netPayable != null) dd.netPayable = money(body.netPayable);

  if (dd.credits == null) dd.credits = Array.isArray(body.creditRows) && body.creditRows.length > 0;

  if (!dd.customerName && body.customerName) dd.customerName = body.customerName;

  if (!dd.replyHref) {
    const replyTo = body.replyTo || body.dynamicData?.replyTo;
    const subject = body.subject || body.dynamicData?.subject || "Invoice reminder";
    dd.replyHref = replyTo ? `mailto:${encodeURIComponent(replyTo)}?subject=${encodeURIComponent(subject)}` : "#";
  }

  if (!dd.year) dd.year = new Date().getFullYear();

  return dd;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body =
      (typeof req.body === "object" && req.body) ||
      (await req.json?.()) ||
      {};

    const { to, from, replyTo, subject, text, html, templateId } = body;

    if (!to || !from) return res.status(400).json({ error: "Missing 'to' or 'from'." });

    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SENDGRID_API_KEY not set" });

    // Attach CID logo (for src="cid:logo")
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
          content_id: "logo",
        };
      }
    } catch {}

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    const base = {
      from: { email: from },
      ...(replyTo ? { reply_to: { email: replyTo } } : {}),
      ...(inlineLogoAttachment ? { attachments: [inlineLogoAttachment] } : {}),
    };

    let payload;
    if (templateId) {
      const dynamic_template_data = buildDynamicData(body);
      payload = {
        ...base,
        personalizations: [{ to: [{ email: to }], dynamic_template_data }],
        template_id: templateId,
      };
    } else {
      // Fallback: raw HTML
      const content = [];
      if (text) content.push({ type: "text/plain", value: text });
      if (html) content.push({ type: "text/html", value: html });
      payload = {
        ...base,
        personalizations: [{ to: [{ email:]()]()

