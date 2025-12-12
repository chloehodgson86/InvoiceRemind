 (cd "$(git rev-parse --show-toplevel)" && git apply --3way <<'EOF' 
diff --git a/api/sendgrid-templates.js b/api/sendgrid-templates.js
new file mode 100644
index 0000000000000000000000000000000000000000..1fdf30406c8042d1a192b895dc2d7370541a20b7
--- /dev/null
+++ b/api/sendgrid-templates.js
@@ -0,0 +1,34 @@
+// /api/sendgrid-templates.js
+export default async function handler(req, res) {
+  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
+
+  const apiKey = process.env.SENDGRID_API_KEY;
+  if (!apiKey) return res.status(500).json({ error: "SENDGRID_API_KEY not set" });
+
+  try {
+    const r = await fetch("https://api.sendgrid.com/v3/templates?generations=dynamic", {
+      headers: { Authorization: `Bearer ${apiKey}` },
+    });
+
+    if (!r.ok) {
+      const detail = await r.text();
+      return res.status(r.status).json({ error: "Failed to fetch SendGrid templates", detail });
+    }
+
+    const data = await r.json();
+    const templates = (data.templates || []).map((tmpl) => {
+      const activeVersion = (tmpl.versions || []).find((v) => v.active === 1) || (tmpl.versions || [])[0];
+      return {
+        id: tmpl.id,
+        name: tmpl.name,
+        version: activeVersion
+          ? { id: activeVersion.id, name: activeVersion.name, subject: activeVersion.subject }
+          : null,
+      };
+    });
+
+    res.status(200).json({ templates });
+  } catch (err) {
+    res.status(500).json({ error: "Unexpected error fetching templates", detail: err.message });
+  }
+}
 
EOF
)
