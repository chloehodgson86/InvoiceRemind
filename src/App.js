// App.js
import React, { useMemo, useState, useEffect, useCallback } from "react";
import Papa from "papaparse";
import JSZip from "jszip";
import * as RC from "recharts";

/* ---------------- Date helpers for aging ---------------- */
function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

const K = {
  customer: "__customer",
  email: "__email",
  invoice: "__invoice",
  amount: "__amount",
  dueDate: "__dueDate",
};

function money(n) {
  const abs = Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `- $${abs}` : `$${abs}`;
}

function pick(row, map, key) {
  if (!row) return undefined;
  const canonKey = K?.[key];
  if (canonKey && Object.prototype.hasOwnProperty.call(row, canonKey)) {
    return row[canonKey];
  }
  const mappedKey = map?.[key];
  if (mappedKey && Object.prototype.hasOwnProperty.call(row, mappedKey)) {
    return row[mappedKey];
  }
  return undefined;
}

function daysOverdue(due, base = new Date()) {
  const d = toDate(due);
  if (!d) return 0;
  return Math.floor((base - d) / (1000 * 60 * 60 * 24));
}

/* ---------------- Templates ---------------- */
const TEMPLATES = {
  Friendly: `Dear {{Customer}},

The following invoices are currently overdue:

{{InvoiceLines}}

Total overdue:  {{TotalOverdue}}
{{CreditsSection}}

If you've already paid, please ignore this. Otherwise, could you let us know the expected date of payment?

Kind regards,
Accounts Receivable`,

  Firm: `Hello {{Customer}},

Despite previous reminders, the following invoices remain overdue:

{{InvoiceLines}}

Total overdue:  {{TotalOverdue}}
{{CreditsSection}}

Please arrange payment today or reply with your remittance advice and pay date.

Regards,
Accounts Receivable`,

  "Final Notice": `FINAL NOTICE – {{Customer}}

Your account is on hold due to the overdue balance below:

{{InvoiceLines}}

Total overdue:  {{TotalOverdue}}
{{CreditsSection}}

Unless full payment is received within 3 business days, we may suspend further supply.

Accounts Receivable`,
};

/* ---------------- CSV helpers ---------------- */
const PRESETS = {
  customer: [
    "customer",
    "customer name",
    "account name",
    "client",
    "client name",
    "trading name",
  ],
  email: ["email", "e-mail", "email address", "contact email"],
  invoice: [
    "invoice",
    "invoice number",
    "invoice #",
    "inv#",
    "doc",
    "document",
    "invoice id",
    "invoiceid",
    "inv id",
  ],
  amount: [
    "amount",
    "total",
    "debit",
    "balance",
    "amount due",
    "outstanding",
    "total overdue",
    "overdue total",
    "total_overdue",
  ],
  dueDate: ["duedate", "due date", "due", "terms date"],
};

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
  if (/[+-]$/.test(s)) {
    if (s.endsWith("-")) negative = true;
    s = s.replace(/[+-]$/, "").trim();
  }
  if (/\bCR\b/.test(s)) negative = true;

  s = s.replace(/[^0-9.,]/g, "");
  if (s.includes(",") && s.includes(".")) {
    s = s.replace(/,/g, "");
  } else if (s.includes(",") && !s.includes(".")) {
    s = s.replace(/,/g, ".");
  }

  const n = Number(s || 0);
  const val = Number.isFinite(n) ? n : 0;
  return negative ? -val : val;
}

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

function buildEmlFile(to, subject, body) {
  const headers = [
    "MIME-Version: 1.0",
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
  ].join("\r\n");
  return `${headers}\r\n\r\n${body.replace(/\n/g, "\r\n")}\r\n`;
}

/* ---------------- Main App ---------------- */
export default function App() {
  useEffect(() => {
    document.title = "Overdue Invoice Reminder Generator — by Chloe Hodgson";
  }, []);

  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [map, setMap] = useState({
    customer: "",
    invoice: "",
    amount: "",
    dueDate: "",
    email: "",
  });

  const [tplKey, setTplKey] = useState("Friendly");
  const [customTpl, setCustomTpl] = useState(TEMPLATES.Friendly);

  // AUTO-GENERATION SETTINGS
  const [autoGenerate, setAutoGenerate] = useState(false);
  const [autoAction, setAutoAction] = useState("zip");

  const [dash, setDash] = useState({
    mailOpened: 0,
    emlCreated: 0,
    missingEmail: 0,
  });

  const [selected, setSelected] = useState(new Set());

  // Memoized customer data
  const customerData = useMemo(() => {
    if (!rows.length) return { all: [], emailable: [], byName: new Map() };

    const byName = new Map();

    // Build customer data map
    for (const r of rows) {
      const name = (pick(r, map, "customer") ?? "").toString().trim();
      if (!name) continue;

      if (!byName.has(name)) {
        byName.set(name, { rows: [], email: null, overdueTotal: 0 });
      }

      const data = byName.get(name);
      data.rows.push(r);

      const amt = cleanNumber(pick(r, map, "amount"));
      if (amt > 0) data.overdueTotal += amt;

      if (!data.email) {
        const email = (pick(r, map, "email") ?? "").toString().trim();
        if (email) data.email = email;
      }
    }

    const all = Array.from(byName.keys());
    const emailable = all.filter((name) => {
      const data = byName.get(name);
      return data.overdueTotal > 0;
    });

    return { all, emailable, byName };
  }, [rows, map]);

  // Generate email function
  const generateEmail = useCallback(
    (customerName) => {
      const data = customerData.byName.get(customerName);
      if (!data) return null;

      const custRows = data.rows;
      const overdueRows = custRows.filter(
        (r) => cleanNumber(pick(r, map, "amount")) > 0
      );
      const creditRows = custRows.filter(
        (r) => cleanNumber(pick(r, map, "amount")) < 0
      );

      const overdueLines = overdueRows.map((r) => {
        const inv = pick(r, map, "invoice") ?? "";
        const due = pick(r, map, "dueDate") ?? "";
        const amt = cleanNumber(pick(r, map, "amount"));
        return `- Invoice ${inv} — ${money(amt)} due ${due}`;
      });

      const creditLines = creditRows.map((r) => {
        const ref = pick(r, map, "invoice") ?? "";
        const date = pick(r, map, "dueDate") ?? "";
        const amt = cleanNumber(pick(r, map, "amount"));
        return `- Credit ${ref} — ${money(amt)} dated ${date}`;
      });

      const totalOverdue = overdueRows.reduce(
        (s, r) => s + cleanNumber(pick(r, map, "amount")),
        0
      );
      const totalCredits = creditRows.reduce(
        (s, r) => s + Math.abs(cleanNumber(pick(r, map, "amount"))),
        0
      );
      const netPayable = totalOverdue - totalCredits;

      const contact = data.email || "";
      const subject = `Paramount Liquor Overdue Invoices - ${customerName}`;

      const chosen =
        tplKey === "Custom"
          ? customTpl
          : TEMPLATES[tplKey] || TEMPLATES.Friendly;
      const creditsSection =
        creditRows.length > 0
          ? `
    Unapplied credits (available to offset):
    ${creditLines.join("\n")}
    
    Total credits: ${money(totalCredits)}

    Net amount now due: ${money(netPayable)}
    
    `
          : "";

      const body = chosen
        .replaceAll("{{Customer}}", customerName)
        .replaceAll("{{InvoiceLines}}", overdueLines.join("\n") || "(none)")
        .replaceAll("{{TotalOverdue}}", money(totalOverdue))
        .replaceAll("{{CreditsSection}}", creditsSection);

      return { contact, subject, body };
    },
    [customerData, map, tplKey, customTpl]
  );

  // Bulk mailto
  const openSelectedMailto = useCallback(
    async (customerList) => {
      const list = customerList || Array.from(selected);
      if (!list.length) return;

      const delay = (ms) => new Promise((r) => setTimeout(r, ms));
      let opened = 0,
        missing = 0;

      for (const name of list) {
        const email = generateEmail(name);
        if (!email || !email.contact) {
          missing++;
          continue;
        }
        window.open(
          `mailto:${encodeURIComponent(
            email.contact
          )}?subject=${encodeURIComponent(
            email.subject
          )}&body=${encodeURIComponent(email.body)}`,
          "_blank"
        );
        opened++;
        await delay(300);
      }

      setDash((d) => ({
        ...d,
        mailOpened: d.mailOpened + opened,
        missingEmail: d.missingEmail + missing,
      }));
    },
    [selected, generateEmail]
  );

  // Bulk ZIP
  const downloadSelectedAsZip = useCallback(
    async (customerList) => {
      const list = customerList || Array.from(selected);
      if (!list.length) return;

      const zip = new JSZip();
      for (const name of list) {
        const email = generateEmail(name);
        if (!email) continue;
        const eml = buildEmlFile(
          email.contact || "",
          email.subject,
          email.body
        );
        const filename = `${name.replace(/[^a-z0-9]/gi, "_")}.eml`;
        zip.file(filename, eml, { compression: "STORE" });
      }

      const blob = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "overdue_emails_selected.zip";
      a.click();
      URL.revokeObjectURL(url);
      setDash((d) => ({ ...d, emlCreated: d.emlCreated + list.length }));
    },
    [selected, generateEmail]
  );

  // CSV upload
  function handleUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    const buffer = [];
    let headersSet = false;
    let guessed = null;

    Papa.parse(file, {
      header: true,
      worker: true,
      skipEmptyLines: true,
      dynamicTyping: true,
      chunkSize: 1024 * 256,
      chunk: ({ data, meta }) => {
        if (!headersSet) {
          const hdrs = meta?.fields || Object.keys(data[0] || {});
          setHeaders(hdrs);
          guessed = autoMap(hdrs);
          setMap(guessed);
          headersSet = true;
        }

        for (const r of data) {
          const name = (r[guessed.customer] ?? "").toString().trim();
          if (!name) continue;
          const amt = cleanNumber(r[guessed.amount]);
          if (!amt) continue;

          buffer.push({
            [K.customer]: r[guessed.customer],
            [K.email]: r[guessed.email],
            [K.invoice]: r[guessed.invoice],
            [K.amount]: r[guessed.amount],
            [K.dueDate]: r[guessed.dueDate],
          });
        }
      },
      complete: () => {
        setRows(buffer);
        setSelected(new Set());
      },
      error: (err) => {
        console.error(err);
        alert("CSV parse error: " + (err?.message || err));
      },
    });
  }

  // Auto-generate effect - triggers after customerData updates
  useEffect(() => {
    if (!autoGenerate || customerData.emailable.length === 0) return;

    // Select all emailable customers
    setSelected(new Set(customerData.emailable));

    // Execute auto-action
    const execute = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));

      if (autoAction === "mailto") {
        await openSelectedMailto(customerData.emailable);
      } else {
        await downloadSelectedAsZip(customerData.emailable);
      }
    };

    execute();
  }, [customerData.emailable.length]); // Only trigger when data changes

  // Dashboard data
  const dashboard = useMemo(() => {
    const per = new Map();

    for (const r of rows) {
      const name = (pick(r, map, "customer") ?? "").toString().trim();
      if (!name) continue;

      const amt = cleanNumber(pick(r, map, "amount"));
      const due = pick(r, map, "dueDate") ?? "";
      const d = daysOverdue(due);

      const cur = per.get(name) || {
        total: 0,
        count: 0,
        oldestDue: due,
        oldestDays: d,
      };
      cur.total += amt || 0;
      cur.count += 1;

      if (d > (cur.oldestDays ?? 0)) {
        cur.oldestDays = d;
        cur.oldestDue = due;
      }

      per.set(name, cur);
    }

    let totalOverdueAll = 0;
    let withEmail = 0;

    for (const name of customerData.all) {
      const agg = per.get(name);
      if (agg) totalOverdueAll += Math.max(0, agg.total);

      const data = customerData.byName.get(name);
      if (data?.email) withEmail++;
    }

    const buckets = { "0–30": 0, "31–60": 0, "61+": 0 };
    for (const [, agg] of per) {
      const d = agg.oldestDays || 0;
      if (d <= 30) buckets["0–30"] += Math.max(0, agg.total);
      else if (d <= 60) buckets["31–60"] += Math.max(0, agg.total);
      else buckets["61+"] += Math.max(0, agg.total);
    }

    const pie = Object.entries(buckets).map(([name, value]) => ({
      name,
      value: Number(value.toFixed(2)),
    }));

    const top = [...per.entries()]
      .map(([name, agg]) => ({
        name,
        total: Number(Math.max(0, agg.total).toFixed(2)),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    return {
      totals: {
        customers: customerData.all.length,
        withEmail,
        selected: selected.size,
        totalOverdueAll: Number(totalOverdueAll.toFixed(2)),
      },
      pie,
      top,
    };
  }, [rows, map, customerData, selected.size]);

  const allSelected =
    selected.size === customerData.emailable.length &&
    customerData.emailable.length > 0;

  return (
    <div style={{ padding: 20, fontFamily: "Inter, system-ui, sans-serif" }}>
      <h1>Overdue Invoice Reminder Generator</h1>

      {/* AUTO-GENERATION CONTROLS */}
      <div
        style={{
          background: "#f0f9ff",
          border: "2px solid #0284c7",
          borderRadius: 12,
          padding: 16,
          marginBottom: 16,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 12, fontSize: 16 }}>
          🤖 Auto-Generation Settings
        </div>
        <div
          style={{
            display: "flex",
            gap: 16,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="checkbox"
              checked={autoGenerate}
              onChange={(e) => setAutoGenerate(e.target.checked)}
            />
            <span>Enable auto-generation on CSV upload</span>
          </label>

          {autoGenerate && (
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span>Auto-action:</span>
              <select
                value={autoAction}
                onChange={(e) => setAutoAction(e.target.value)}
                style={{
                  padding: 6,
                  borderRadius: 6,
                  border: "1px solid #0284c7",
                  background: "white",
                }}
              >
                <option value="zip">Download ZIP (all emails)</option>
                <option value="mailto">Open mailto links</option>
              </select>
            </label>
          )}
        </div>
        {autoGenerate && (
          <div
            style={{
              marginTop: 8,
              fontSize: 13,
              color: "#0369a1",
              fontStyle: "italic",
            }}
          >
            ✨ Emails will be auto-generated immediately after uploading CSV
          </div>
        )}
      </div>

      <input type="file" accept=".csv" onChange={handleUpload} />

      {/* Mapping panel */}
      {headers.length > 0 && (
        <div
          style={{
            marginTop: 16,
            border: "1px solid #eee",
            borderRadius: 12,
            padding: 12,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8 }}>
            Map your CSV columns
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
              gap: 12,
            }}
          >
            {[
              ["customer", "Customer (required)"],
              ["email", "Email (optional)"],
              ["invoice", "Invoice # (required)"],
              ["amount", "Amount (required)"],
              ["dueDate", "Due Date (required)"],
            ].map(([key, label]) => (
              <label
                key={key}
                style={{ display: "grid", gap: 6, fontSize: 12 }}
              >
                <span>{label}</span>
                <select
                  value={map[key]}
                  onChange={(e) =>
                    setMap((m) => ({ ...m, [key]: e.target.value }))
                  }
                  style={{
                    padding: 8,
                    borderRadius: 8,
                    border: "1px solid #ddd",
                  }}
                >
                  <option value="">— choose a header —</option>
                  {headers.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <div style={{ marginTop: 12 }}>
            <label>
              Template:&nbsp;
              <select
                value={tplKey}
                onChange={(e) => setTplKey(e.target.value)}
              >
                {Object.keys(TEMPLATES).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
                <option value="Custom">Custom…</option>
              </select>
            </label>
          </div>

          {tplKey === "Custom" && (
            <textarea
              value={customTpl}
              onChange={(e) => setCustomTpl(e.target.value)}
              placeholder="Use {{Customer}}, {{InvoiceLines}}, {{TotalOverdue}}, {{CreditsSection}}"
              rows={6}
              style={{
                width: "100%",
                marginTop: 8,
                padding: 10,
                borderRadius: 8,
                border: "1px solid #ddd",
                fontFamily: "inherit",
              }}
            />
          )}
        </div>
      )}

      {/* Bulk toolbar */}
      {customerData.emailable.length > 0 && (
        <div
          style={{
            marginTop: 16,
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          <label>
            <input
              type="checkbox"
              checked={allSelected}
              onChange={(e) =>
                setSelected(
                  e.target.checked ? new Set(customerData.emailable) : new Set()
                )
              }
            />{" "}
            Select all
          </label>
          <button onClick={() => setSelected(new Set(customerData.emailable))}>
            Select all
          </button>
          <button
            onClick={() => setSelected(new Set())}
            disabled={!selected.size}
          >
            Clear
          </button>
          <button
            onClick={() => openSelectedMailto()}
            disabled={!selected.size}
            style={{
              background: "#1a73e8",
              color: "#fff",
              padding: "6px 12px",
              borderRadius: 6,
            }}
          >
            Open Mailto ({selected.size})
          </button>
          <button
            onClick={() => downloadSelectedAsZip()}
            disabled={!selected.size}
            style={{
              background: "#16a34a",
              color: "#fff",
              padding: "6px 12px",
              borderRadius: 6,
            }}
          >
            Download .eml (ZIP)
          </button>
        </div>
      )}

      {/* DASHBOARD */}
      {customerData.all.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h2>Dashboard</h2>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            {[
              ["Total customers", dashboard.totals.customers],
              ["With email", dashboard.totals.withEmail],
              ["Selected", dashboard.totals.selected],
              [
                "Total overdue (all)",
                `$${dashboard.totals.totalOverdueAll.toLocaleString()}`,
              ],
              ["Mailto opened", dash.mailOpened],
              ["EML files created", dash.emlCreated],
              ["Missing email (skipped)", dash.missingEmail],
            ].map(([label, value]) => (
              <div
                key={label}
                style={{
                  border: "1px solid #eee",
                  borderRadius: 12,
                  padding: 12,
                }}
              >
                <div style={{ fontSize: 12, color: "#666" }}>{label}</div>
                <div style={{ fontWeight: 700, fontSize: 18 }}>{value}</div>
              </div>
            ))}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 16,
              marginTop: 16,
            }}
          >
            <div
              style={{
                height: 280,
                border: "1px solid #eee",
                borderRadius: 12,
                padding: 8,
              }}
            >
              <div style={{ fontWeight: 600, margin: "4px 8px" }}>
                Amount by Aging Bucket
              </div>
              <RC.ResponsiveContainer width="100%" height="90%">
                <RC.PieChart>
                  <RC.Pie
                    data={dashboard.pie}
                    dataKey="value"
                    nameKey="name"
                    outerRadius={80}
                    label
                  >
                    {dashboard.pie.map((_, i) => (
                      <RC.Cell key={i} />
                    ))}
                  </RC.Pie>
                  <RC.Tooltip />
                  <RC.Legend />
                </RC.PieChart>
              </RC.ResponsiveContainer>
            </div>

            <div
              style={{
                height: 280,
                border: "1px solid #eee",
                borderRadius: 12,
                padding: 8,
              }}
            >
              <div style={{ fontWeight: 600, margin: "4px 8px" }}>
                Top 10 Customers by Overdue
              </div>
              <RC.ResponsiveContainer width="100%" height="90%">
                <RC.BarChart data={dashboard.top}>
                  <RC.CartesianGrid strokeDasharray="3 3" />
                  <RC.XAxis dataKey="name" hide />
                  <RC.YAxis />
                  <RC.Tooltip />
                  <RC.Bar dataKey="total">
                    {dashboard.top.map((_, i) => (
                      <RC.Cell key={i} />
                    ))}
                  </RC.Bar>
                </RC.BarChart>
              </RC.ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* Customer list */}
      {customerData.emailable.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <h2>Generated Emails</h2>
          {customerData.emailable.map((cust) => {
            const email = generateEmail(cust);
            if (!email) return null;
            const { contact, subject, body } = email;
            return (
              <div
                key={cust}
                style={{
                  border: "1px solid #e5e5e5",
                  padding: 12,
                  borderRadius: 12,
                  marginTop: 12,
                }}
              >
                <div
                  style={{ display: "flex", justifyContent: "space-between" }}
                >
                  <div>
                    <input
                      type="checkbox"
                      checked={selected.has(cust)}
                      onChange={() => {
                        const next = new Set(selected);
                        next.has(cust) ? next.delete(cust) : next.add(cust);
                        setSelected(next);
                      }}
                    />{" "}
                    <strong>{cust}</strong>{" "}
                    {contact && <span>({contact})</span>}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {contact && (
                      <a
                        href={`mailto:${encodeURIComponent(
                          contact
                        )}?subject=${encodeURIComponent(
                          subject
                        )}&body=${encodeURIComponent(body)}`}
                        style={{
                          background: "#007bff",
                          color: "white",
                          padding: "6px 12px",
                          borderRadius: 6,
                          textDecoration: "none",
                          fontSize: 14,
                        }}
                      >
                        Open Email
                      </a>
                    )}
                    <button
                      onClick={() => {
                        const eml = buildEmlFile(contact || "", subject, body);
                        const blob = new Blob([eml], {
                          type: "message/rfc822",
                        });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = `${cust.replace(/[^a-z0-9]/gi, "_")}.eml`;
                        a.click();
                        URL.revokeObjectURL(url);
                        setDash((d) => ({
                          ...d,
                          emlCreated: d.emlCreated + 1,
                        }));
                      }}
                      style={{
                        background: "#28a745",
                        color: "white",
                        padding: "6px 12px",
                        borderRadius: 6,
                        fontSize: 14,
                        border: "none",
                      }}
                    >
                      Download .eml
                    </button>
                  </div>
                </div>

                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    background: "#fafafa",
                    borderRadius: 8,
                    padding: 8,
                    marginTop: 10,
                  }}
                >{`Subject: ${subject}\n\n${body}`}</pre>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
