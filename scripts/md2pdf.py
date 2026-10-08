"""Render a project markdown doc to a print-quality PDF via headless Chrome.

Chrome rather than reportlab because the source is real markdown with nested
tables, fenced code and inline formatting - reimplementing that layout by hand
in reportlab would be a worse renderer than the one already on the machine.
"""
import re
import subprocess
import sys
from pathlib import Path

import markdown

SRC = Path(sys.argv[1]).resolve()
# Absolute: Chrome resolves --print-to-pdf against ITS OWN working directory,
# not ours, so a relative path silently writes somewhere else.
OUT = Path(sys.argv[2]).resolve()
OUT.parent.mkdir(parents=True, exist_ok=True)
TITLE = sys.argv[3] if len(sys.argv) > 3 else SRC.stem
SUBTITLE = sys.argv[4] if len(sys.argv) > 4 else ""
# Cover facts, one per line, separated by "|". Each document states its own -
# a hardcoded line here once printed "150 questions" on every cover.
STACK = "Event-driven microservices &middot; Go &middot; Kafka &middot; Redis"
META = sys.argv[5].split("|") if len(sys.argv) > 5 and sys.argv[5] else []

text = SRC.read_text(encoding="utf-8")

# The markdown has a "## Contents" table of in-page anchors. Those links do not
# resolve the same way once the page is paginated, and a PDF reader has its own
# outline, so the table stays but is rendered as plain text rather than links.
html_body = markdown.markdown(
    text,
    extensions=["tables", "fenced_code", "sane_lists", "attr_list"],
)

# Each "### <n>. <question>" starts a card. Wrapping every question in a block
# that avoids breaking mid-answer is what stops a question landing alone at the
# foot of a page with its answer overleaf.
html_body = re.sub(
    r'<thead>\s*<tr>(?:\s*<th[^>]*>\s*</th>\s*)+</tr>\s*</thead>',
    '', html_body,
)

html_body = re.sub(
    r'<h3>(\d+)\.\s*(.*?)</h3>',
    r'<div class="qbreak"></div><h3><span class="qnum">\1</span>\2</h3>',
    html_body,
)

CSS = """
@page { size: A4; margin: 18mm 16mm 20mm 16mm; }

:root {
  --ink:   #1c1a17;
  --body:  #33302b;
  --muted: #6b6659;
  --leaf:  #2a6a46;
  --leaf-light: #f1f8f3;
  --rule:  #e3d8c4;
  --code-bg: #f7f5f0;
}

* { box-sizing: border-box; }

body {
  font-family: "Georgia", "Cambria", serif;
  font-size: 10.2pt;
  line-height: 1.55;
  color: var(--body);
  margin: 0;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

/* ------------------------------------------------------------ cover */
.cover {
  height: 247mm;
  display: flex;
  flex-direction: column;
  justify-content: center;
  page-break-after: always;
  text-align: center;
}
.cover .rule { width: 54px; height: 3px; background: var(--leaf); margin: 0 auto 26px; }
.cover h1 {
  font-size: 30pt; line-height: 1.15; margin: 0 0 14px;
  color: var(--ink); border: 0; padding: 0;
}
.cover .sub { font-size: 12.5pt; color: var(--muted); margin: 0 0 40px; font-style: italic; }
.cover .meta {
  font-family: "Segoe UI", system-ui, sans-serif;
  font-size: 9pt; color: var(--muted); line-height: 1.9;
  border-top: 1px solid var(--rule); padding-top: 18px;
  display: inline-block; min-width: 62mm;
}
.cover .meta b { color: var(--ink); }

/* ---------------------------------------------------------- headings */
h1, h2, h3, h4 {
  font-family: "Segoe UI Semibold", "Segoe UI", system-ui, sans-serif;
  color: var(--ink);
  line-height: 1.25;
  page-break-after: avoid;
  break-after: avoid;
}

h1 {
  font-size: 19pt;
  margin: 0 0 16px;
  padding-bottom: 8px;
  border-bottom: 2px solid var(--leaf);
}

/* Section headers (## A - Opening...) start a fresh page: the sections are
   what someone flips between while revising. */
h2 {
  font-size: 15pt;
  margin: 0 0 18px;
  padding: 10px 12px;
  background: var(--leaf-light);
  border-left: 4px solid var(--leaf);
  page-break-before: always;
  break-before: page;
}
/* The first two h2s (Contents, Quick reference) follow the cover, which has
   already forced a break. */
h2.nobreak { page-break-before: avoid; break-before: avoid; }

h3 {
  font-size: 11.4pt;
  margin: 20px 0 8px;
  color: var(--leaf);
}
.qnum {
  display: inline-block;
  min-width: 22px;
  margin-right: 7px;
  padding: 1px 6px;
  background: var(--leaf);
  color: #fff;
  border-radius: 4px;
  font-size: 9pt;
  text-align: center;
}

h4 { font-size: 10.4pt; margin: 14px 0 6px; }

/* Keep a question with the start of its answer. */
.qbreak { page-break-inside: avoid; }
h3 + p, h3 + blockquote, h3 + ul, h3 + ol, h3 + table, h3 + pre {
  page-break-before: avoid; break-before: avoid;
}

p { margin: 0 0 9px; orphans: 2; widows: 2; }

/* ----------------------------------------------------------- quotes */
blockquote {
  margin: 10px 0;
  padding: 9px 14px;
  background: var(--leaf-light);
  border-left: 3px solid var(--leaf);
  color: var(--ink);
  font-style: italic;
}
blockquote p:last-child { margin-bottom: 0; }

/* ------------------------------------------------------------ lists */
ul, ol { margin: 0 0 9px; padding-left: 22px; }
li { margin-bottom: 4px; }
li > p { margin-bottom: 4px; }

/* ----------------------------------------------------------- tables */
table {
  width: 100%;
  border-collapse: collapse;
  margin: 11px 0;
  font-family: "Segoe UI", system-ui, sans-serif;
  font-size: 8.8pt;
  page-break-inside: avoid;
  break-inside: avoid;
}
th {
  background: var(--leaf);
  color: #fff;
  text-align: left;
  padding: 6px 8px;
  font-weight: 600;
}
td { padding: 5px 8px; border-bottom: 1px solid var(--rule); vertical-align: top; }
tbody tr:nth-child(even) { background: #faf8f4; }

/* ------------------------------------------------------------- code */
pre {
  background: var(--code-bg);
  border: 1px solid var(--rule);
  border-radius: 4px;
  padding: 9px 11px;
  margin: 10px 0;
  font-size: 8.4pt;
  line-height: 1.45;
  white-space: pre;
  overflow: hidden;
  page-break-inside: avoid;
  break-inside: avoid;
}
pre, code {
  font-family: Consolas, "Cascadia Mono", "Lucida Console", monospace;
  font-variant-ligatures: none;
}
code {
  background: var(--code-bg);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 8.8pt;
}
pre code { background: none; padding: 0; font-size: inherit; }

hr { border: 0; border-top: 1px solid var(--rule); margin: 18px 0; }

a { color: var(--leaf); text-decoration: none; }
strong { color: var(--ink); }
"""

html = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>{TITLE}</title>
<style>{CSS}</style></head><body>
<div class="cover">
  <div class="rule"></div>
  <h1>{TITLE}</h1>
  <p class="sub">{SUBTITLE}</p>
  <div style="text-align:center"><div class="meta">
    {"".join(f"{line}<br>" for line in META)}{STACK}
  </div></div>
</div>
{html_body}
</body></html>"""

# The first two h2s sit on the cover's page break already.
html = html.replace("<h2>Contents</h2>", '<h2 class="nobreak">Contents</h2>', 1)

tmp_html = OUT.with_suffix(".html")
tmp_html.write_text(html, encoding="utf-8")

chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
subprocess.run(
    [chrome, "--headless", "--disable-gpu", "--no-pdf-header-footer",
     f"--print-to-pdf={OUT}", tmp_html.resolve().as_uri()],
    check=True, capture_output=True, timeout=180,
)
import pymupdf

doc = pymupdf.open(OUT)
total = len(doc)
for i, page in enumerate(doc):
    if i == 0:
        continue  # the cover carries no furniture
    w, h = page.rect.width, page.rect.height
    page.draw_line(pymupdf.Point(45, h - 38), pymupdf.Point(w - 45, h - 38),
                   color=(0.89, 0.85, 0.77), width=0.6)
    page.insert_text((45, h - 26), TITLE, fontsize=7.5,
                     fontname="helv", color=(0.42, 0.40, 0.35))
    label = f"{i + 1} / {total}"
    page.insert_text((w - 45 - pymupdf.get_text_length(label, "helv", 7.5), h - 26),
                     label, fontsize=7.5, fontname="helv", color=(0.42, 0.40, 0.35))

doc.set_metadata({
    "title": f"{TITLE} - {SUBTITLE}",
    "subject": "Interview preparation: 150 questions with answers",
    "creator": "HungerHeal project docs",
})
# Save beside the original and swap: pymupdf refuses a non-incremental save
# over the file it has open.
stamped = OUT.with_name(OUT.stem + ".stamped.pdf")
doc.save(stamped, deflate=True, garbage=3)
doc.close()
stamped.replace(OUT)
tmp_html.unlink(missing_ok=True)
print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB, {total} pages)")
