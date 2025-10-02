// /api/sendgrid-send.js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = (typeof req.body === "object" && req.body) || {};
    const {
      to,
      from,
      replyTo,
      templateId,             // dynamic template id
      subject: rawSubject,     // optional fallback
      dynamicData = {},        // preferred place for data
      // optional raw fields if you send them top-level:
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
    if (!apiKey) return res.status(500).json({ error: "SENDGRID_API_KEY not set" });

    // ----- Helpers -----
    const money = (n) =>
      (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2, });

    const safe = (v, d = "") => (v == null ? d : v);

    // Prefer dynamicData, fall back to top-level fields if provided
    const dyn = {
      customerName: safe(dynamicData.customerName, customerName),
      overdueRows: safe(dynamicData.overdueRows, overdueRows) || [],
      creditRows: safe(dynamicData.creditRows, creditRows) || [],
      totalOverdue: safe(dynamicData.totalOverdue, totalOverdue),
      totalCredits: safe(dynamicData.totalCredits, totalCredits),
      netPayable: safe(dynamicData.netPayable, netPayable),
      subject: safe(dynamicData.subject, rawSubject),
    };

    // Build the mailto used by the CTA in your template
    const replyHref = replyTo
      ? `mailto:${encodeURIComponent(replyTo)}?subject=${encodeURIComponent(dyn.subject || "")}`
      : `mailto:accounts@paramountliquor.com.au?subject=${encodeURIComponent(dyn.subject || "")}`;

    // Build the HTML row strings your template uses ({{{invoiceRows}}}/{{{creditSection}}})
    const invoiceRowsHtml =
      dyn.overdueRows.length > 0
        ? dyn.overdueRows
            .map((r) => {
              const inv = safe(r.inv);
              const due = safe(r.due);
              const amt = r.amt != null && typeof r.amt === "number" ? `$${money(r.amt)}` : safe(r.amt, "");
              return `
                <tr>
                  <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${inv}</td>
                  <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${amt}</td>
                  <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${due}</td>
                </tr>`;
            })
            .join("")
        : `<tr><td colspan="3" style="padding:10px;">(none)</td></tr>`;

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
                const amt = cr.amt != null && typeof cr.amt === "number" ? `$${money(Math.abs(cr.amt))}` : safe(cr.amt, "");
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
      totalOverdue: typeof dyn.totalOverdue === "number" ? `$${money(dyn.totalOverdue)}` : dyn.totalOverdue,
      totalCredits: typeof dyn.totalCredits === "number" ? `$${money(dyn.totalCredits)}` : dyn.totalCredits,
      netPayable: typeof dyn.netPayable === "number" ? `$${money(dyn.netPayable)}` : dyn.netPayable,
    };

    // Inline CID logo
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
    } catch {}

    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };

    const personalization = {
      to: [{ email: to }],
      subject: dyn.subject || rawSubject || "",              // <-- subject for dynamic template
      dynamic_template_data: {
        customerName: dyn.customerName || "",
        invoiceRows: invoiceRowsHtml,
        creditSection: creditSectionHtml,
        credits: (dyn.creditRows || []).length > 0,
        totalOverdue: totals.totalOverdue ?? "",
        totalCredits: totals.totalCredits ?? "",
        netPayable: totals.netPayable ?? "",
        replyHref,
        year: new Date().getFullYear(),
      },
    };

    const payload = {
      from: { email: from },
      ...(replyTo ? { reply_to: { email: replyTo } } : {}),
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

    return res.status(200).json({
      ok: true,
      inlineLogoAttached: Boolean(inlineLogoAttachment),
    });
  } catch (e) {
    return res.status(500).json({ error: e?.message || "Unknown error" });
  }
}

