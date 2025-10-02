// /api/sendgrid-send.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Accept both Vercel's req.body object and raw JSON body
    const body =
      (typeof req.body === "object" && req.body) ||
      (typeof req.json === "function" ? await req.json() : {}) ||
      {};

    const {
      to,                         // string or string[]
      from,                       // required: "no-reply@..." or { email, name }
      replyTo,                    // optional: "accounts@..." or { email, name }
      bcc,                        // optional: string or string[]

      // SendGrid Dynamic Template Id
      templateId,

      // Optional subject fallback (you can also pass it in dynamicData.subject)
      subject: rawSubject,

      // Preferred container for template data
      dynamicData = {},

      // Optional top-level shortcuts if you send them directly
      customerName,
      overdueRows,
      creditRows,
      totalOverdue,
      totalCredits,
      netPayable,
    } = body;

    if (!to || !from || !templateId) {
      return res
        .status(400)
        .json({ error: "Missing 'to', 'from', or 'templateId'." });
    }

    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "SENDGRID_API_KEY not set" });
    }

    /* ---------------- Helpers ---------------- */
    const asArray = (v) =>
      Array.isArray(v) ? v.filter(Boolean) : v ? [v] : [];

    const money = (n) =>
      (Number(n) || 0).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

    const safe = (v, d = "") => (v == null ? d : v);

    // Prefer dynamicData; fall back to top-level fields for convenience
    const dyn = {
      customerName: safe(dynamicData.customerName, customerName),
      overdueRows: safe(dynamicData.overdueRows, overdueRows) || [],
      creditRows: safe(dynamicData.creditRows, creditRows) || [],
      totalOverdue: safe(dynamicData.totalOverdue, totalOverdue),
      totalCredits: safe(dynamicData.totalCredits, totalCredits),
      netPayable: safe(dynamicData.netPayable, netPayable),
      subject: safe(dynamicData.subject, rawSubject),
      payNowUrl: safe(dynamicData.payNowUrl, ""),
      replyHrefExplicit: dynamicData.replyHref, // allow overriding mailto entirely
    };

    // Build mailto used by CTA (unless overridden by replyHref in dynamicData)
    const replyHref =
      dyn.replyHrefExplicit ||
      (replyTo
        ? `mailto:${
            typeof replyTo === "string" ? encodeURIComponent(replyTo) : encodeURIComponent(replyTo.email)
          }?subject=${encodeURIComponent(dyn.subject || "")}`
        : `mailto:accounts@paramountliquor.com.au?subject=${encodeURIComponent(
            dyn.subject || ""
          )}`);

    // Build invoice rows -> string for {{{invoiceRows}}} in your template
    const invoiceRowsHtml =
      dyn.overdueRows.length > 0
        ? dyn.overdueRows
            .map((r) => {
              const inv = safe(r.inv);
              const due = safe(r.due);
              const rawAmt = r.amt;
              const amt =
                rawAmt != null && typeof rawAmt === "number"
                  ? `$${money(rawAmt)}`
                  : safe(rawAmt, "");
              return `
                <tr>
                  <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${inv}</td>
                  <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${amt}</td>
                  <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${due}</td>
                </tr>`;
            })
            .join("")
        : `<tr><td colspan="3" style="padding:10px;">(none)</td></tr>`;

    // Optional credits block -> string for {{{creditSection}}}
    const creditSectionHtml =
      (dyn.creditRows || []).length > 0
        ? `
      <h3 style="margin:24px 0 8px 0;font-size:16px;color:#0f172a;">Unapplied credits</h3>
      <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <thead>
          <tr style="background:#f8fafc;">
            <th align="left"  style="padding:10px 12px;font-size:12px;color:#475569;">Reference</th>
            <th align="right" style="padding:10px 12px;font-size:12px;color:#475569;">Amount</th>
            <th align="right" style="padding:10px 12px;font-size:12px;color:#475569;">Date</th>
          </tr>
        </thead>
        <tbody>
          ${dyn.creditRows
            .map((cr) => {
              const ref = safe(cr.ref);
              const date = safe(cr.date);
              const rawAmt = cr.amt;
              const amt =
                rawAmt != null && typeof rawAmt === "number"
                  ? `$${money(Math.abs(rawAmt))}`
                  : safe(rawAmt, "");
              return `
                <tr>
                  <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;">${ref}</td>
                  <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${amt}</td>
                  <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${date}</td>
                </tr>`;
            })
            .join("")}
        </tbody>
      </table>`
        : "";

    // Format totals if they are numbers
    const totals = {
      totalOverdue:
        typeof dyn.totalOverdue === "number"
          ? `$${money(dyn.totalOverdue)}`
          : dyn.totalOverdue,
      totalCredits:
        typeof dyn.totalCredits === "number"
          ? `$${money(dyn.totalCredits)}`
          : dyn.totalCredits,
      netPayable:
        typeof dyn.netPayable === "number"
          ? `$${money(dyn.netPayable)}`
          : dyn.netPayable,
    };

    /* ---------------- Inline CID logo (optional but recommended) ----------------
       - If LOGO_URL env is set, we fetch it and attach as a CID (content_id: "logo")
       - In your SendGrid Dynamic Template, reference it with: <img src="cid:logo" ...>
    ------------------------------------------------------------------------------ */
    const publicLogoUrl =
      process.env.LOGO_URL || "https://invoice-remind.vercel.app/logo.png";

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
          content_id: "logo", // <img src="cid:logo">
        };
      }
    } catch {
      // Ignore logo fetch failures; email will still send
    }

    /* ---------------- Build SendGrid request ---------------- */
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    // Normalize recipients
    const toList = asArray(to).map((email) => ({ email }));
    const bccList = asArray(bcc).map((email) => ({ email }));

    const personalization = {
      to: toList,
      ...(bccList.length ? { bcc: bccList } : {}),
      subject: dyn.subject || rawSubject || "", // Subject for dynamic template
      dynamic_template_data: {
        customerName: dyn.customerName || "",
        invoiceRows: invoiceRowsHtml,
        creditSection: creditSectionHtml,
        credits: (dyn.creditRows || []).length > 0,
        totalOverdue: totals.totalOverdue ?? "",
        totalCredits: totals.totalCredits ?? "",
        netPayable: totals.netPayable ?? "",
        payNowUrl: dyn.payNowUrl || "", // if your template has a {{payNowUrl}} button
        replyHref,
        year: new Date().getFullYear(),
      },
    };

    const payload = {
      from:
        typeof from === "string"
          ? { email: from }
          : { email: from.email, ...(from.name ? { name: from.name } : {}) },
      ...(replyTo
        ? typeof replyTo === "string"
          ? { reply_to: { email: replyTo } }
          : { reply_to: { email: replyTo.email, ...(replyTo.name ? { name: replyTo.name } : {}) } }
        : {}),
      ...(inlineLogoAttachment ? { attachments: [inlineLogoAttachment] } : {}),
      personalizations: [personalization],
      template_id: templateId,
      // Optional: enable sandbox mode via env for safe testing (no real send)
      ...(process.env.SENDGRID_SANDBOX === "true"
        ? { mail_settings: { sandbox_mode: { enable: true } } }
        : {}),
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
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}

