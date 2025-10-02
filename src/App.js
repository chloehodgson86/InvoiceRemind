// App.js
import React, { useMemo, useState, useEffect, useCallback } from "react";
import Papa from "papaparse";
import JSZip from "jszip";
import * as RC from "recharts";

/* ---------------- Branding ---------------- */
const BRAND = {
  name: "Paramount Liquor",
  dept: "Accounts Receivable",
  primary: "#0f172a",
  accent: "#0ea5e9",
  border: "#e5e7eb",
  subtle: "#f8fafc",
  text: "#0f172a",
  muted: "#475569",
  footer: "#64748b",
  logoUrl: "/logo.png", // put logo file in /public/logo.png
};

/* ---------------- Helpers ---------------- */
function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}
function daysOverdue(due, base = new Date()) {
  const d = toDate(due);
  if (!d) return 0;
  return Math.floor((base - d) / (1000 * 60 * 60 * 24));
}
function money(n) {
  const abs = Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `- $${abs}` : `$${abs}`;
}
function cleanNumber(v) {
  if (v == null || v === "") return 0;
  let s = String(v).trim().toUpperCase();
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1).trim();
  }
  if (/\bCR\b/.test(s)) negative = true;
  s = s.replace(/[^0-9.,]/g, "");
  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/,/g, "");
  } else if (s.includes(",") && !s.includes(".")) {
    s = s.replace(/,/g, ".");
  }
  const n = Number(s || 0);
  return negative ? -n : n;
}

/* ---------------- CSV mapping ---------------- */
const PRESETS = {
  customer: ["customer", "customer name", "account name", "client", "trading name"],
  email: ["email", "e-mail", "email address"],
  invoice: ["invoice", "invoice number", "invoice #", "doc"],
  amount: ["amount", "total", "balance", "amount due", "outstanding"],
  dueDate: ["duedate", "due date", "due"],
};
function autoMap(headers) {
  const hLow = headers.map((h) => String(h).toLowerCase());
  const pick = (list) => {
    for (const want of list) {
      const i = hLow.indexOf(want);
      if (i !== -1) return headers[i];
    }
    for (const want of list) {
      const i = hLow.findIndex((h) => h.includes(want));
      if (i !== -1) return headers[i];
    }
    return "";
  };
  return {
    customer: pick(PRESETS.customer),
    email: pick(PRESETS.email),
    invoice: pick(PRESETS.invoice),
    amount: pick(PRESETS.amount),
    dueDate: pick(PRESETS.dueDate),
  };
}

/* ---------------- HTML email template ---------------- */
function htmlEmailTemplate({
  customerName,
  subject,
  overdueRows,
  creditRows,
  totalOverdue,
  totalCredits,
  netPayable,
  replyTo,
  templateLabel = "",
}) {
  const invRows = overdueRows.map(r => `
    <tr>
      <td style="padding:10px 12px;border-bottom:1px solid ${BRAND.border};">${r.inv}</td>
      <td style="padding:10px 12px;border-bottom:1px solid ${BRAND.border};text-align:right;">${money(r.amt)}</td>
      <td style="padding:10px 12px;border-bottom:1px solid ${BRAND.border};text-align:right;">${r.due}</td>
    </tr>
  `).join("");

  const creditSection = creditRows.length ? `
    <h3 style="margin:24px 0 8px 0;font-size:16px;color:${BRAND.text};">Unapplied credits</h3>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fff;border:1px solid ${BRAND.border};border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:${BRAND.subtle};">
          <th align="left" style="padding:10px 12px;font-size:12px;color:${BRAND.muted};">Reference</th>
          <th align="right" style="padding:10px 12px;font-size:12px;color:${BRAND.muted};">Amount</th>
          <th align="right" style="padding:10px 12px;font-size:12px;color:${BRAND.muted};">Date</th>
        </tr>
      </thead>
      <tbody>
        ${creditRows.map(cr => `
          <tr>
            <td style="padding:10px 12px;border-bottom:1px solid ${BRAND.border};">${cr.ref}</td>
            <td style="padding:10px 12px;border-bottom:1px solid ${BRAND.border};text-align:right;">${money(cr.amt)}</td>
            <td style="padding:10px 12px;border-bottom:1px solid ${BRAND.border};text-align:right;">${cr.date}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  ` : "";

  const replyHref = replyTo
    ? `mailto:${encodeURIComponent(replyTo)}?subject=${encodeURIComponent(subject)}`
    : "#";

  const logoUrl = "https://invoice-remind.vercel.app/logo.png";

  return `<!doctype html>
<html>
<body style="margin:0;background:#f1f5f9;padding:24px;font-family:Arial,sans-serif;color:${BRAND.text};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center">
        <table role="presentation" width="640" style="max-width:640px;background:#fff;border:1px solid ${BRAND.border};border-radius:12px;overflow:hidden;">
          <!-- Header bar -->
          <tr>
            <td style="background:${BRAND.primary};color:#fff;padding:18px 20px;">
              <span style="font-size:18px;font-weight:700;">${BRAND.name}</span>
              <span style="font-size:12px;opacity:.85;margin-left:8px;">${BRAND.dept}</span>
            </td>
          </tr>

<!-- Logo row -->
<tr>
  <td style="padding:16px;text-align:center;background:#ffffff;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center">
      <tr>
        <td align="center">
          <img src="cid:logo"
               width="240"
               alt="Paramount Liquor"
               style="display:block;height:auto;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;" />
        </td>
      </tr>
    </table>
  </td>
</tr>


          <!-- Main body -->
          <tr>
            <td style="padding:16px 24px 24px 24px;">
              <p>Dear <strong>${customerName}</strong>,</p>
              <p>Our system is showing that the following invoices are currently overdue:</p>
              <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.border};border-radius:8px;">
                <thead>
                  <tr style="background:${BRAND.subtle};">
                    <th align="left">Invoice</th>
                    <th align="right">Amount</th>
                    <th align="right">Due Date</th>
                  </tr>
                </thead>
                <tbody>
                  ${invRows || `<tr><td colspan="3" style="padding:10px 12px;">(none)</td></tr>`}
                </tbody>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.subtle};border:1px solid ${BRAND.border};border-radius:8px;">
                <tr>
                  <td style="padding:12px;">
                    <strong>Total overdue: ${money(totalOverdue)}</strong><br/>
                    ${creditRows.length ? `Credits: ${money(totalCredits)}<br/>Net payable: ${money(netPayable)}` : ""}
                  </td>
                </tr>
              </table>

              ${creditSection}

              <p style="padding-top:8px;">If these invoices have already been paid, please ignore this reminder.</p>
              <p>Otherwise, kindly make prompt payment and send remittance advice to <a href="mailto:accounts@paramountliquor.com.au">accounts@paramountliquor.com.au</a>.</p>

              <!-- Buttons row (bulletproof for Outlook) -->
              <table role="presentation" cellpadding="0" cellspacing="0" style="padding-top:8px;">
                <tr>
                  <td style="padding-right:12px;">
                    <!--[if mso]>
                    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${replyHref}" arcsize="10%" stroke="f" fillcolor="${BRAND.accent}" style="height:40px;v-text-anchor:middle;width:220px;">
                      <w:anchorlock/>
                      <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:14px;font-weight:700;">
                        Reply with remittance
                      </center>
                    </v:roundrect>
                    <![endif]-->
                    <!--[if !mso]><!-- --><a href="${replyHref}"
                      style="background:${BRAND.accent};color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;display:inline-block;">
                      Reply with remittance
                    </a><!--<![endif]-->
                  </td>
                  <td>
                    <!--[if mso]>
                    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="https://www.paramountliquor.com.au/sign-in" arcsize="10%" stroke="f" fillcolor="#16a34a" style="height:40px;v-text-anchor:middle;width:140px;">
                      <w:anchorlock/>
                      <center style="color:#ffffff;font-family:Arial,sans-serif;font-size:14px;font-weight:700;">
                        Pay Now
                      </center>
                    </v:roundrect>
                    <![endif]-->
                    <!--[if !mso]><!-- --><a href="https://www.paramountliquor.com.au/sign-in"
                      style="background:#16a34a;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;display:inline-block;">
                      Pay Now
                    </a><!--<![endif]-->
                  </td>
                </tr>
              </table>

              <p style="padding-top:16px;">Kind regards,<br/>${BRAND.dept}<br/>${BRAND.name}</p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="text-align:center;color:${BRAND.footer};font-size:12px;padding:12px;">
              © ${new Date().getFullYear()} ${BRAND.name} 
              | This is an automated reminder – please contact <a href="mailto:accounts@paramountliquor.com.au">accounts@paramountliquor.com.au</a> if you need assistance.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}


/* ---------------- Main App ---------------- */
export default function App() {
  useEffect(() => {
    document.title = "Overdue Invoice Reminder Generator — by Chloe Hodgson";
  }, []);

  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [map, setMap] = useState({ customer: "", invoice: "", amount: "", dueDate: "", email: "" });
  const [selected, setSelected] = useState(new Set());
  const [sgFrom, setSgFrom] = useState("");
  const [sgReplyTo, setSgReplyTo] = useState("");
  const [sending, setSending] = useState(false);

  // Parse CSV
  function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const buffer = [];
    let headersSet = false;
    let guessed = null;

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      chunk: ({ data, meta }) => {
        if (!headersSet) {
          const hdrs = meta?.fields || Object.keys(data[0] || {});
          setHeaders(hdrs);
          guessed = autoMap(hdrs);
          setMap(guessed);
          headersSet = true;
        }
        for (const r of data) {
          buffer.push(r);
        }
      },
      complete: () => setRows(buffer),
    });
  }

  // Group by customer
  const customerData = useMemo(() => {
    const byName = new Map();
    for (const r of rows) {
      const name = (r[map.customer] ?? "").toString().trim();
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, { rows: [], email: r[map.email] || "" });
      byName.get(name).rows.push(r);
    }
    return { all: Array.from(byName.keys()), byName };
  }, [rows, map]);

  // Generate email
  const generateEmail = useCallback((customerName) => {
    const data = customerData.byName.get(customerName);
    if (!data) return null;

    const custRows = data.rows;
    const overdueRows = custRows.filter(r => cleanNumber(r[map.amount]) > 0)
      .map(r => ({ inv: r[map.invoice], due: r[map.dueDate], amt: cleanNumber(r[map.amount]) }));
    const creditRows = custRows.filter(r => cleanNumber(r[map.amount]) < 0)
      .map(r => ({ ref: r[map.invoice], date: r[map.dueDate], amt: cleanNumber(r[map.amount]) }));

    const totalOverdue = overdueRows.reduce((s, r) => s + r.amt, 0);
    const totalCredits = creditRows.reduce((s, r) => s + Math.abs(r.amt), 0);
    const netPayable = totalOverdue - totalCredits;

      if (overdueRows.length === 0) return null;
    if (netPayable <= 0) return null;
    const subject = `Paramount Liquor Overdue Invoices - ${customerName}`;
    const textBody = `Dear ${customerName},

The following invoices are overdue:

${overdueRows.map(r => `- ${r.inv} ${money(r.amt)} due ${r.due}`).join("\n")}

Total overdue: ${money(totalOverdue)}

Kind regards,
${BRAND.dept}`;

    const htmlBody = htmlEmailTemplate({
      customerName,
      subject,
      overdueRows,
      creditRows,
      totalOverdue,
      totalCredits,
      netPayable,
      replyTo: sgReplyTo,
    });

    return { contact: data.email, subject, body: textBody, html: htmlBody };
  }, [customerData, map, sgReplyTo]);

  // Send via SendGrid
  const sendSelectedViaSendGrid = useCallback(async () => {
    const list = Array.from(selected);
    if (!list.length) return;
    if (!sgFrom) {
      alert("Enter a From address verified in SendGrid.");
      return;
    }
    setSending(true);
    let ok = 0, fail = 0, skipped = 0;

    for (const name of list) {
      const email = generateEmail(name);
      if (!email || !email.contact) { skipped++; continue; }
      try {
        const res = await fetch("/api/sendgrid-send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: email.contact,
            subject: email.subject,
            text: email.body,
            html: email.html,
            from: sgFrom,
            replyTo: sgReplyTo || undefined,
          }),
        });
        if (res.ok) ok++; else fail++;
      } catch { fail++; }
      await new Promise(r => setTimeout(r, 150));
    }
    setSending(false);
    alert(`Done. Success: ${ok}, Fail: ${fail}, Skipped: ${skipped}`);
  }, [selected, generateEmail, sgFrom, sgReplyTo]);

  return (
    <div style={{ padding: 20 }}>
      <h1>Overdue Invoice Reminder Generator</h1>
      <input type="file" accept=".csv" onChange={handleUpload} />

      <div style={{ marginTop: 16 }}>
        <input placeholder="From (verified in SendGrid)" value={sgFrom} onChange={e => setSgFrom(e.target.value)} />
        <input placeholder="Reply-To (optional)" value={sgReplyTo} onChange={e => setSgReplyTo(e.target.value)} />
        <button disabled={!selected.size || sending} onClick={sendSelectedViaSendGrid}>
          {sending ? "Sending..." : `Send ${selected.size} via SendGrid`}
        </button>
      </div>

      {customerData.all.map(cust => {
        const email = generateEmail(cust);
        if (!email) return null;
        return (
          <div key={cust} style={{ marginTop: 20, border: "1px solid #ccc", padding: 12 }}>
            <label>
              <input
                type="checkbox"
                checked={selected.has(cust)}
                onChange={() => {
                  const next = new Set(selected);
                  next.has(cust) ? next.delete(cust) : next.add(cust);
                  setSelected(next);
                }}
              />
              <strong>{cust}</strong> ({email.contact || "no email"})
            </label>
            <pre style={{ whiteSpace: "pre-wrap", background: "#fafafa", padding: 8, marginTop: 8 }}>
              {`Subject: ${email.subject}\n\n${email.body}`}
            </pre>
            <details>
              <summary>Preview HTML</summary>
              <div dangerouslySetInnerHTML={{ __html: email.html }} />
            </details>
          </div>
        );
      })}
    </div>
  );
}
