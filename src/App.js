// App.js
import React, { useMemo, useState, useEffect, useCallback } from "react";
import Papa from "papaparse";

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
};

// Hosted logo for in-app preview (emails use CID via SendGrid backend)
const PREVIEW_LOGO = "https://invoice-remind.vercel.app/logo.png";
// Available SendGrid dynamic templates
// Fallback SendGrid dynamic templates (used when we cannot fetch live from API)
const TEMPLATE_OPTIONS = [
  { id: "d-c32e5033436a4186a760c43071a0a103", label: "Overdue reminder (default)", subject: "Overdue Invoice Reminder" },
  { id: "d-a0bf347c9f054340a0f1e41ec36f2f3c", label: "Upcoming due - 15 days to EOM", subject: "Upcoming Invoice Reminder - 15 days to EOM" },
  { id: "d-1e3c9c13c9c948e6b7c6caa21fba1fbb", label: "Upcoming due - 30 days to EOM", subject: "Upcoming Invoice Reminder - 30 days to EOM" },
  { id: "d-8f4c87f1e8aa4a17b4d182f025fe2a0c", label: "Generic invoice reminder", subject: "Invoice Reminder" },
  { id: "custom", label: "Custom template…", subject: "Invoice Reminder" },
];

// Fallback SendGrid dynamic templates (used when we cannot fetch live from API)
const TEMPLATE_OPTIONS = [
  { id: "d-c32e5033436a4186a760c43071a0a103", label: "Overdue reminder (default)", subject: "Overdue Invoice Reminder" },
  { id: "d-a0bf347c9f054340a0f1e41ec36f2f3c", label: "Upcoming due - 15 days to EOM", subject: "Upcoming Invoice Reminder - 15 days to EOM" },
  { id: "d-1e3c9c13c9c948e6b7c6caa21fba1fbb", label: "Upcoming due - 30 days to EOM", subject: "Upcoming Invoice Reminder - 30 days to EOM" },
  { id: "d-8f4c87f1e8aa4a17b4d182f025fe2a0c", label: "Generic invoice reminder", subject: "Invoice Reminder" },
  // Provide an ASCII-only fallback label to avoid encoding issues during CI/CD parsing
  { id: "custom", label: "Custom template...", subject: "Invoice Reminder" },
];

/* ---------------- Helpers ---------------- */
function money(n) {
  const abs = Math.abs(Number(n) || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `- $${abs}` : `$${abs}`;
}
function cleanNumber(v) {
  if (v == null || v === "") return 0;
  let s = String(v).trim().toUpperCase();
  let negative = false;
  if (s.startsWith("(") && s.endsWith(")")) { negative = true; s = s.slice(1, -1).trim(); }
  if (s.startsWith("-")) { negative = true; s = s.slice(1).trim(); }
  if (/\bCR\b/.test(s)) negative = true;
  s = s.replace(/[^0-9.,]/g, "");
  if (s.includes(",") && s.includes(".")) s = s.replace(/,/g, "");
  else if (s.includes(",") && !s.includes(".")) s = s.replace(/,/g, ".");
  const n = Number(s || 0);
  return negative ? -n : n;
}
const getTemplateMeta = (id, options = TEMPLATE_OPTIONS) =>
  options.find((opt) => opt.id === id) || options.find((opt) => opt.id === "custom") || {};


const getTemplateMeta = (id, options = TEMPLATE_OPTIONS) =>
  options.find((opt) => opt.id === id) || options.find((opt) => opt.id === "custom") || {};

function buildSubjectLine(templateId, templateOptions, customerName) {
  const tmplMeta = getTemplateMeta(templateId, templateOptions);
  const subjectContext = (tmplMeta.subject || "Invoice Reminder").toString().trim() || "Invoice Reminder";
  const subjectRaw = `Paramount Liquor - ${subjectContext} - ${customerName || "Customer"}`;
  const subject = subjectRaw.trim();
  return subject || "Paramount Liquor Invoice Reminder";
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

/* ---------------- In-app preview HTML ---------------- */
function buildPreviewHtml({
  customerName,
  overdueRows,
  creditRows,
  totalOverdue,
  totalCredits,
  netPayable,
  replyHref,
}) {
  const invRows = overdueRows.length
    ? overdueRows.map(r => `
        <tr>
          <td style="padding:10px;border-bottom:1px solid ${BRAND.border};">${r.inv ?? ""}</td>
          <td style="padding:10px;border-bottom:1px solid ${BRAND.border};text-align:right;">${money(r.amt)}</td>
          <td style="padding:10px;border-bottom:1px solid ${BRAND.border};text-align:right;">${r.due ?? ""}</td>
        </tr>
      `).join("")
    : `<tr><td colspan="3" style="padding:10px;">(none)</td></tr>`;

  const creditSection = creditRows.length ? `
    <h3 style="margin:24px 0 8px 0;font-size:16px;color:${BRAND.text};">Unapplied credits</h3>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#fff;border:1px solid ${BRAND.border};border-radius:8px;overflow:hidden;">
      <thead>
        <tr style="background:${BRAND.subtle};">
          <th align="left"  style="padding:10px 12px;font-size:12px;color:${BRAND.muted};">Reference</th>
          <th align="right" style="padding:10px 12px;font-size:12px;color:${BRAND.muted};">Amount</th>
          <th align="right" style="padding:10px 12px;font-size:12px;color:${BRAND.muted};">Date</th>
        </tr>
      </thead>
      <tbody>
        ${creditRows.map(cr => `
          <tr>
            <td style="padding:10px 12px;border-bottom:1px solid ${BRAND.border};">${cr.ref ?? ""}</td>
            <td style="padding:10px 12px;border-bottom:1px solid ${BRAND.border};text-align:right;">${money(cr.amt)}</td>
            <td style="padding:10px 12px;border-bottom:1px solid ${BRAND.border};text-align:right;">${cr.date ?? ""}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>` : "";

  return `
  <div style="max-width:640px;border:1px solid ${BRAND.border};border-radius:12px;overflow:hidden;background:#fff">
    <div style="background:${BRAND.primary};color:#fff;padding:18px 20px;font-weight:700;">
      ${BRAND.name} <span style="font-weight:400;opacity:.85;margin-left:8px;">${BRAND.dept}</span>
    </div>
    <div style="padding:16px;text-align:center;background:#fff;">
      <img src="${PREVIEW_LOGO}" alt="Paramount Liquor" style="max-width:360px;height:auto;display:block;margin:0 auto;" />
    </div>
    <div style="padding:24px;color:${BRAND.text};font-family:Arial,sans-serif;">
      <p>Dear <strong>${customerName}</strong>,</p>
      <p>Our system is showing that the following invoices are currently overdue:</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${BRAND.border};border-radius:8px;">
        <thead>
          <tr style="background:${BRAND.subtle};">
            <th align="left" style="padding:10px;font-size:12px;color:${BRAND.muted};">Invoice</th>
            <th align="right" style="padding:10px;font-size:12px;color:${BRAND.muted};">Amount</th>
            <th align="right" style="padding:10px;font-size:12px;color:${BRAND.muted};">Due Date</th>
          </tr>
        </thead>
        <tbody>${invRows}</tbody>
      </table>
      <div style="margin:16px 0;padding:12px;background:${BRAND.subtle};border:1px solid ${BRAND.border};border-radius:8px;">
        <strong>Total overdue: ${money(totalOverdue)}</strong><br/>
        ${creditRows.length ? `Credits: ${money(totalCredits)}<br/>Net payable: ${money(netPayable)}` : ""}
      </div>
      ${creditSection}

      <!-- Buttons (preview only) -->
      <table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:20px auto;">
        <tr>
          <td align="center" style="padding-right:8px;">
            <a href="${replyHref}"
               style="background:${BRAND.accent};color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600;display:inline-block;">
              Reply with remittance
            </a>
          </td>
          <td align="center" style="padding-left:8px;">
            <a href="https://www.paramountliquor.com.au/sign-in"
               style="background:#16a34a;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600;display:inline-block;">
              Pay Now
            </a>
          </td>
        </tr>
      </table>
    </div>
  </div>`;
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
  const [templateOptions, setTemplateOptions] = useState(TEMPLATE_OPTIONS);
  const [templateId, setTemplateId] = useState(TEMPLATE_OPTIONS[0].id);
  const [customTemplateId, setCustomTemplateId] = useState("");
  const [sending, setSending] = useState(false);

  // Fetch live SendGrid templates (requires SENDGRID_API_KEY in the hosting environment)
  useEffect(() => {
    let ignore = false;

    async function loadTemplates() {
      try {
        const res = await fetch("/api/sendgrid-templates");
        if (!res.ok) throw new Error(`Failed to fetch templates (${res.status})`);
        const data = await res.json();
        const liveTemplates = (data.templates || []).map((tmpl) => {
          const subject = tmpl.version?.subject || "Invoice Reminder";
          const versionName = tmpl.version?.name ? ` – ${tmpl.version.name}` : "";
          return {
            id: tmpl.id,
            label: `${tmpl.name || tmpl.id}${versionName}`,
            subject,
          };
        });

        const withCustom = [...liveTemplates, TEMPLATE_OPTIONS.find((t) => t.id === "custom")];
        if (!ignore && withCustom.length) {
          setTemplateOptions(withCustom);
          setTemplateId(liveTemplates[0]?.id || TEMPLATE_OPTIONS[0].id);
        }
      } catch (err) {
        console.warn("Falling back to predefined template list", err);
        if (!ignore) setTemplateOptions(TEMPLATE_OPTIONS);
      }
    }

    loadTemplates();
    return () => { ignore = true; };
  }, []);

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
        for (const r of data) buffer.push(r);
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

  /* -------------- Send via SendGrid Dynamic Template -------------- */
  const sendSelectedViaSendGrid = useCallback(async () => {
    const list = Array.from(selected);
    if (!list.length) return;
    if (!sgFrom) {
      alert("Enter a From address verified in SendGrid.");
      return;
    }
    const chosenTemplateId =
      templateId === "custom" ? customTemplateId.trim() : templateId;
    const subjectTemplateId = templateId === "custom" ? "custom" : templateId;
    if (!chosenTemplateId) {
      alert("Select or enter a SendGrid dynamic template ID.");
      return;
    }
    setSending(true);
    let ok = 0, fail = 0, skipped = 0;

    for (const name of list) {
      const data = customerData.byName.get(name);
      if (!data) { skipped++; continue; }

      const custRows = data.rows;
      const overdueRows = custRows.filter(r => cleanNumber(r[map.amount]) > 0)
        .map(r => ({ inv: r[map.invoice], due: r[map.dueDate], amt: cleanNumber(r[map.amount]) }));
      const creditRows = custRows.filter(r => cleanNumber(r[map.amount]) < 0)
        .map(r => ({ ref: r[map.invoice], date: r[map.dueDate], amt: cleanNumber(r[map.amount]) }));

      const totalOverdue = overdueRows.reduce((s, r) => s + r.amt, 0);
      const totalCredits = creditRows.reduce((s, r) => s + Math.abs(r.amt), 0);
      const netPayable = totalOverdue - totalCredits;

      // Skip if nothing owing
      if (overdueRows.length === 0 || netPayable <= 0) { skipped++; continue; }

      try {
        const subject = buildSubjectLine(subjectTemplateId, templateOptions, name);

        const res = await fetch("/api/sendgrid-send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: data.email,
            from: sgFrom,
            replyTo: sgReplyTo || undefined,
            templateId: chosenTemplateId,
            dynamicData: {
              customerName: name,
              overdueRows,
              creditRows,
              totalOverdue: money(totalOverdue),
              totalCredits: money(totalCredits),
              netPayable: money(netPayable),
              subject,
              emailSubject: subject,
              title: subject,
            },
            subject, // top-level subject for the email header
          }),
        });
        if (res.ok) ok++; else fail++;
      } catch {
        fail++;
      }
      await new Promise(r => setTimeout(r, 150));
    }
    setSending(false);
    alert(`Done. Success: ${ok}, Fail: ${fail}, Skipped: ${skipped}`);
  }, [selected, customerData, map, sgFrom, sgReplyTo, templateId, customTemplateId, templateOptions]);

  return (
    <div style={{ padding: 20 }}>
      <h1>Overdue Invoice Reminder Generator</h1>
      <input type="file" accept=".csv" onChange={handleUpload} />

      <div style={{ marginTop: 16 }}>
        <input placeholder="From (verified in SendGrid)" value={sgFrom} onChange={e => setSgFrom(e.target.value)} />
        <input placeholder="Reply-To (optional)" value={sgReplyTo} onChange={e => setSgReplyTo(e.target.value)} />
        <div style={{ display: "inline-flex", gap: 8, alignItems: "center", marginLeft: 8 }}>
          <label>
            Template:
            <select
              value={templateId}
              onChange={e => setTemplateId(e.target.value)}
              style={{ marginLeft: 6 }}
            >
              {templateOptions.map(opt => (
                <option key={opt.id} value={opt.id}>{opt.label}</option>
              ))}
            </select>
          </label>
          {templateId === "custom" && (
            <input
              placeholder="SendGrid template ID (d-...)"
              value={customTemplateId}
              onChange={e => setCustomTemplateId(e.target.value)}
            />
          )}
        </div>
        <button disabled={!selected.size || sending} onClick={sendSelectedViaSendGrid}>
          {sending ? "Sending..." : `Send ${selected.size} via SendGrid`}
        </button>
      </div>

      {customerData.all.map(cust => {
        const data = customerData.byName.get(cust);
        if (!data) return null;

        // Build preview inputs
        const custRows = data.rows;
        const overdueRows = custRows.filter(r => cleanNumber(r[map.amount]) > 0)
          .map(r => ({ inv: r[map.invoice], due: r[map.dueDate], amt: cleanNumber(r[map.amount]) }));
        const creditRows = custRows.filter(r => cleanNumber(r[map.amount]) < 0)
          .map(r => ({ ref: r[map.invoice], date: r[map.dueDate], amt: cleanNumber(r[map.amount]) }));
        const totalOverdue = overdueRows.reduce((s, r) => s + r.amt, 0);
        const totalCredits = creditRows.reduce((s, r) => s + Math.abs(r.amt), 0);
        const netPayable = totalOverdue - totalCredits;

        // Skip accounts with no amount owing in the list UI
        if (overdueRows.length === 0 || netPayable <= 0) return null;

        const subject = buildSubjectLine(templateId, templateOptions, cust);
        const replyHref = sgReplyTo
          ? `mailto:${encodeURIComponent(sgReplyTo)}?subject=${encodeURIComponent(subject)}`
          : `mailto:accounts@paramountliquor.com.au?subject=${encodeURIComponent(subject)}`;

        const previewHtml = buildPreviewHtml({
          customerName: cust,
          overdueRows,
          creditRows,
          totalOverdue,
          totalCredits,
          netPayable,
          replyHref,
        });

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
              <strong>{cust}</strong> ({data.email || "no email"})
            </label>

            <details style={{ marginTop: 8 }}>
              <summary>Preview</summary>
              <div dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </details>
          </div>
        );
      })}
    </div>
  );
}

