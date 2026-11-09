# PDF

## Read

```python
import pdfplumber
with pdfplumber.open("in.pdf") as pdf:
    print(len(pdf.pages), "pages")
    for i, page in enumerate(pdf.pages, 1):
        text = page.extract_text() or ""
        print(f"--- page {i} ---\n{text[:2000]}")
        for table in page.extract_tables():
            print(table[:5])          # rows as lists of cells
```

- `pypdf` is faster for plain text and metadata: `PdfReader("in.pdf").pages[0].extract_text()`.
- No text at all usually means a scanned page: it needs OCR (`pytesseract` with Tesseract installed, or
  `ocrmypdf in.pdf out.pdf`). Say so rather than reporting the PDF as empty.
- Form fields: `PdfReader("in.pdf").get_fields()`.

## Change pages

```python
from pypdf import PdfReader, PdfWriter
w = PdfWriter()
for path in ["a.pdf", "b.pdf"]:          # merge
    for p in PdfReader(path).pages:
        w.add_page(p)
w.write("merged.pdf")
```

- Split: write each page (or range) to its own `PdfWriter`.
- Rotate: `page.rotate(90)` before `add_page`.
- Fill a form: `w.append(PdfReader("form.pdf"))`, then
  `w.update_page_form_field_values(w.pages[0], {"Name": "Ada"}, auto_regenerate=False)`.
- Encrypted files: `reader.decrypt(password)` first (ask the user for it).

## Create

For a simple document, write Word (`.docx`) or HTML and convert with LibreOffice
(`soffice --headless --convert-to pdf`). For precise layouts, `reportlab`:

```python
from reportlab.lib.pagesizes import A4
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table
from reportlab.lib.styles import getSampleStyleSheet
s = getSampleStyleSheet()
doc = SimpleDocTemplate("out.pdf", pagesize=A4)
doc.build([Paragraph("Quarterly report", s["Title"]), Spacer(1, 12), Table([["Region", "Sales"], ["North", "120"]])])
```
