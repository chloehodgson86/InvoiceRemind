// /api/sendgrid-send.js
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body =
      (typeof req.body === "object" && req.body) ||
      (typeof req.json === "function" ? await req.json() : {}) ||
      {};

    const {
      to,                   // string or string[]
      from,                 // required
      replyTo,              // optional
      bcc,                  // optional
      templateId,           // required (SendGrid dynamic template id)

      // optional manual subject, else we'll compute it
      subject: rawSubject,

      // preferred container for template data
      dynamicData = {},

      // convenience fallbacks if passed at top level
      customerName,
      overdueRows,
      creditRows,
      totalOverdue,
      totalCredits,
      netPayable,
    } = body;

    if (!to || !from || !templateId) {
      return res.status(400).json({ error: "Missing 'to', 'from', or 'templateId'." });
    }

    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: "SENDGRID_API_KEY not set" });
    }

    /* ---------------- helpers ---------------- */
    const asArray = (v) => (Array.isArray(v) ? v.filter(Boolean) : v ? [v] : []);
    const money = (n) =>
      (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const safe = (v, d = "") => (v == null ? d : v);

    const dyn = {
      customerName: safe(dynamicData.customerName, customerName),
      overdueRows: safe(dynamicData.overdueRows, overdueRows) || [],
      creditRows: safe(dynamicData.creditRows, creditRows) || [],
      totalOverdue: safe(dynamicData.totalOverdue, totalOverdue),
      totalCredits: safe(dynamicData.totalCredits, totalCredits),
      netPayable: safe(dynamicData.netPayable, netPayable),
      subject: safe(dynamicData.subject, rawSubject),
      // force Pay Now to go to the website if nothing provided
      payNowUrl: safe(dynamicData.payNowUrl, "https://www.paramountliquor.com.au/"),
      replyHref: dynamicData.replyHref, // optional full override
    };

    // Compute subject if missing, based on customer name (your requirement)
    const computedSubject =
      dyn.subject ||
      `Overdue Invoice Reminder — ${dyn.customerName || "Customer"}`;

    // Build mailto used by CTA when not overridden
    const replyHref =
      dyn.replyHref ||
      (replyTo
        ? `mailto:${typeof replyTo === "string" ? encodeURIComponent(replyTo) : encodeURIComponent(replyTo.email)}?subject=${encodeURIComponent(computedSubject)}`
        : `mailto:accounts@paramountliquor.com.au?subject=${encodeURIComponent(computedSubject)}`);

    // Build invoice rows HTML for {{{invoiceRows}}}
    const invoiceRowsHtml =
      dyn.overdueRows.length
        ? dyn.overdueRows
            .map((r) => {
              const inv = safe(r.inv);
              const due = safe(r.due);
              const amt =
                r.amt != null && typeof r.amt === "number" ? `$${money(r.amt)}` : safe(r.amt, "");
              return `
                <tr>
                  <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${inv}</td>
                  <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${amt}</td>
                  <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${due}</td>
                </tr>`;
            })
            .join("")
        : `<tr><td colspan="3" style="padding:10px;">(none)</td></tr>`;

    // Optional credits block HTML for {{{creditSection}}}
    const creditSectionHtml =
      (dyn.creditRows || []).length
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
                  const amt =
                    cr.amt != null && typeof cr.amt === "number"
                      ? `$${money(Math.abs(cr.amt))}`
                      : safe(cr.amt, "");
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

    // Format totals if numeric
    const totals = {
      totalOverdue: typeof dyn.totalOverdue === "number" ? `$${money(dyn.totalOverdue)}` : dyn.totalOverdue,
      totalCredits: typeof dyn.totalCredits === "number" ? `$${money(dyn.totalCredits)}` : dyn.totalCredits,
      netPayable: typeof dyn.netPayable === "number" ? `$${money(dyn.netPayable)}` : dyn.netPayable,
    };

    /* ----- Inline CID logo (optional) ----- */
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
          content_id: "logo", // <img src="cid:logo">
        };
      }
    } catch {
      // ignore failure; email still sends
    }

    /* ----- Build SendGrid payload ----- */
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    const toList = asArray(to).map((email) => ({ email }));
    const bccList = asArray(bcc).map((email) => ({ email }));

    const personalization = {
      to: toList,
      ...(bccList.length ? { bcc: bccList } : {}),
      subject: computedSubject, // ← ensure subject is always set
      dynamic_template_data: {
        customerName: dyn.customerName || "",
        invoiceRows: invoiceRowsHtml,
        creditSection: creditSectionHtml,
        credits: (dyn.creditRows || []).length > 0,
        totalOverdue: totals.totalOverdue ?? "",
        totalCredits: totals.totalCredits ?? "",
        netPayable: totals.netPayable ?? "",
        payNowUrl: dyn.payNowUrl, // ← always a real URL
        replyHref,
        year: new Date().getFullYear(),
      },
    };

    const payload = {
      from: typeof from === "string" ? { email: from } : { email: from.email, ...(from.name ? { name: from.name } : {}) },
      ...(replyTo
        ? typeof replyTo === "string"
          ? { reply_to: { email: replyTo } }
          : { reply_to: { email: replyTo.email, ...(replyTo.name ? { name: replyTo.name } : {}) } }
        : {}),
      ...(inlineLogoAttachment ? { attachments: [inlineLogoAttachment] } : {}),
      personalizations: [personalization],
      template_id: templateId,
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

    return res.status(200).json({ ok: true, inlineLogoAttached: Boolean(inlineLogoAttachment) });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}

