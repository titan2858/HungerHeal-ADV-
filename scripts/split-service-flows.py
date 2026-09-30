"""Split docs/SERVICE-FLOWS.md into one PDF per service.

The combined document is the source; this only carves it up, so the two can
never drift. Node services get the shared-skeleton section appended, because
without it a single service's page is missing most of its context.
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "docs" / "SERVICE-FLOWS.md"
OUT_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "docs" / "service-flows"
MD2PDF = ROOT / "scripts" / "md2pdf.py"

OUT_DIR.mkdir(parents=True, exist_ok=True)
text = SRC.read_text(encoding="utf-8")

# Sections are "## <n> — <name>". Split on them, keeping the heading.
parts = re.split(r"^## ", text, flags=re.M)[1:]
sections = {}
for part in parts:
    heading = part.split("\n", 1)[0].strip()
    sections[heading] = "## " + part.rstrip() + "\n"

skeleton = next((v for k, v in sections.items() if "shared Node skeleton" in k), "")

GO_SERVICES = {"agent-location-service", "assignment-engine"}

made = []
for heading, body in sections.items():
    m = re.match(r"(\d+)\s+—\s+(.*)", heading)
    if not m:
        continue
    num, name = int(m.group(1)), m.group(2)

    # 1 is the skeleton and 2 is the cross-service overview; neither is a
    # service of its own.
    if num < 3:
        continue

    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    md = OUT_DIR / f"{slug}.md"

    content = body
    is_go = any(g in name for g in GO_SERVICES)
    if skeleton and not is_go and "gateway" not in name:
        content += (
            "\n---\n\n"
            "## Appendix — the shared skeleton\n\n"
            "Repeated here so this page stands alone. Every Node service has "
            "these same files doing the same jobs.\n\n"
            + skeleton.split("\n", 1)[1]
        )

    md.write_text(content, encoding="utf-8")
    pdf = OUT_DIR / f"{slug}.pdf"
    subprocess.run(
        [sys.executable, str(MD2PDF), str(md), str(pdf),
         name, "Request flow, file by file"],
        check=True, capture_output=True, timeout=300,
    )
    md.unlink()
    made.append((slug, pdf.stat().st_size // 1024))

for slug, kb in sorted(made):
    print(f"  {slug:26s} {kb:4d} KB")
print(f"{len(made)} per-service PDFs in {OUT_DIR}")
