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

  // Send via SendGrid Dynamic Template
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

    if (overdueRows.length === 0 || netPayable <= 0) { skipped++; continue; }

    const subject = `Paramount Liquor Overdue Invoices - ${name}`;

    try {
      const res = await fetch("/api/sendgrid-send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: data.email,
          from: sgFrom,
          replyTo: sgReplyTo || undefined,
          templateId: "d-c32e5033436a4186a760c43071a0a103", // ✅ your template ID
          customerName: name,
          overdueRows,
          creditRows,
          totalOverdue: money(totalOverdue),
          totalCredits: money(totalCredits),
          netPayable: money(netPayable),
          subject,
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
}, [selected, customerData, map, sgFrom, sgReplyTo]);

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
        const data = customerData.byName.get(cust);
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
          </div>
        );
      })}
    </div>
  );
}
