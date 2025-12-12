// /api/sendgrid-send.js
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body =
      (typeof req.body === "object" && req.body) ||
      (typeof req.json === "function" ? await req.json() : {}) ||
      {};

    const {
      to, from, replyTo, bcc, templateId,
      subject: rawSubject,
      dynamicData = {},
      customerName, overdueRows, creditRows, totalOverdue, totalCredits, netPayable,
    } = body;

    if (!to || !from || !templateId) {
      return res.status(400).json({ error: "Missing 'to', 'from', or 'templateId'." });
    }

    const apiKey = process.env.SENDGRID_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "SENDGRID_API_KEY not set" });

    /* ---------------- helpers ---------------- */
    const asArray = (v) => (Array.isArray(v) ? v.filter(Boolean) : v ? [v] : []);
// Formats 1234.5 -> "1,234.50"
const num = (n) =>
  (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Always show as $X.XX (positive display)
const cur = (n) => `$${num(Math.abs(Number(n) || 0))}`;

// Always show as -$X.XX (for credits)
const curNeg = (n) => `- $${num(Math.abs(Number(n) || 0))}`;
// Coerce numbers from strings like "$1,234.56", "1,234.56", "(123.45)"
const toNum = (v) => {
  if (typeof v === "number") return v;
  if (v == null) return 0;
  let s = String(v).trim();
  const neg = /^\(.*\)$/.test(s);   // (123.45) -> negative
  if (neg) s = s.slice(1, -1);
  s = s.replace(/[$,\s]/g, "");     // remove $, commas, spaces
  const n = Number(s);
  return (neg ? -1 : 1) * (isNaN(n) ? 0 : n);
};

// Preserve the sign (for things like Net Payable which could be negative in edge cases)
const curSigned = (n) => {
  const x = Number(n) || 0;
  const a = num(Math.abs(x));
  return x < 0 ? `- $${a}` : `$${a}`;
};

    const safe = (v, d = "") => (v == null ? d : v);

    // Decode common HTML entities so subjects show real characters (', ", &, etc.)
    const decodeEntities = (s) => {
      if (typeof s !== "string") return s;
      const map = {
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&#39;": "'",
        "&#x27;": "'",
        "&apos;": "'",
      };
      return s
        .replace(/(&amp;|&lt;|&gt;|&quot;|&#39;|&#x27;|&apos;)/g, (m) => map[m])
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
    };

    const dyn = {
      customerName: safe(dynamicData.customerName, customerName),
      overdueRows: safe(dynamicData.overdueRows, overdueRows) || [],
      creditRows: safe(dynamicData.creditRows, creditRows) || [],
      totalOverdue: safe(dynamicData.totalOverdue, totalOverdue),
      totalCredits: safe(dynamicData.totalCredits, totalCredits),
      netPayable: safe(dynamicData.netPayable, netPayable),
      payNowUrl: safe(dynamicData.payNowUrl, "https://www.paramountliquor.com.au/sign-in"),
      replyHref: dynamicData.replyHref,
      subject: safe(dynamicData.subject, rawSubject), // may be provided; else we compute below
    };

    // Build the subject in your requested format, de-encoding any entities first
    const nameText = decodeEntities(dyn.customerName || "Customer");
    const cleanedSubject = typeof dyn.subject === "string" ? decodeEntities(dyn.subject).trim() : "";
    const computedSubjectRaw = cleanedSubject || `Paramount Liquor - Invoice Reminder - ${nameText}`;
    const computedSubject = (computedSubjectRaw || "").toString().trim() || "Paramount Liquor Invoice Reminder";

    // Build reply mailto (uses the computed subject)
    const replyHref =
      dyn.replyHref ||
      (replyTo
        ? `mailto:${typeof replyTo === "string" ? encodeURIComponent(replyTo) : encodeURIComponent(replyTo.email)}?subject=${encodeURIComponent(computedSubject)}`
        : `mailto:accounts@paramountliquor.com.au?subject=${encodeURIComponent(computedSubject)}`);

    // Build invoice rows HTML
    const invoiceRowsHtml =
      dyn.overdueRows.length
        ? dyn.overdueRows
            .map((r) => {
              const inv = safe(r.inv);
              const due = safe(r.due);
             const amt =
  r.amt != null && typeof r.amt === "number"
    ? cur(r.amt)
    : safe(r.amt, "");

              return `
                <tr>
                  <td style="padding:10px;border-bottom:1px solid #e5e7eb;">${inv}</td>
                  <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${amt}</td>
                  <td style="padding:10px;border-bottom:1px solid #e5e7eb;text-align:right;">${due}</td>
                </tr>`;
            })
            .join("")
        : `<tr><td colspan="3" style="padding:10px;">(none)</td></tr>`;

    // Credits section HTML (optional)
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
    ? curNeg(cr.amt)          // <- show as negative
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

    // Totals
const totals = {
  totalOverdue:
    dyn.totalOverdue == null ? "" : cur(toNum(dyn.totalOverdue)),
  totalCredits:
    dyn.totalCredits == null ? "" : curNeg(toNum(dyn.totalCredits)), // ← always negative
  netPayable:
    dyn.netPayable == null ? "" : curSigned(toNum(dyn.netPayable)),
};



    // Inline CID logo (optional)
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

    // Build SendGrid payload
    const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
    const toList = asArray(to).map((email) => ({ email }));
    const bccList = asArray(bcc).map((email) => ({ email }));

    const personalization = {
      to: toList,
      ...(bccList.length ? { bcc: bccList } : {}),
      // This is ignored when the template's Subject is set to a static string,
      // but included for completeness. We drive the subject via {{subject}}.
      subject: computedSubject,
      dynamic_template_data: {
        customerName: dyn.customerName || "",
        invoiceRows: invoiceRowsHtml,
        creditSection: creditSectionHtml,
        credits: (dyn.creditRows || []).length > 0,
        totalOverdue: totals.totalOverdue ?? "",
        totalCredits: totals.totalCredits ?? "",
        netPayable: totals.netPayable ?? "",
        payNowUrl: dyn.payNowUrl,
        replyHref,
        subject: computedSubject,   // <- used by {{subject}} in the template Subject field
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
      // Include a subject at the top level so the header is always populated,
      // even if the dynamic template Subject is blank or ignored.
      subject: computedSubject,
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

