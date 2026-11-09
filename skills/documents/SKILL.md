---
name: documents
description: Read, create and edit office files and PDFs (PDF, Word .docx, Excel .xlsx, PowerPoint .pptx) with Python libraries. Use when a task involves one of these files: extracting text or tables, filling a template, building a report or spreadsheet, merging or splitting PDFs.
---

Office files are zip archives of XML and PDFs are page descriptions: read and write them with libraries, never by
editing bytes or guessing at contents. Each format has its own notes in this skill's `formats/` files; read the
one you need (skill tool, `file: "formats/pdf.md"` and so on) before you start.

## 1. Set up once

Use the project's Python environment if it has one (the `python-env` skill finds it); otherwise make a venv for
the job, outside the user's project if the files are not part of it:

```sh
python3 -m venv .venv-docs && . .venv-docs/bin/activate     # Windows: .venv-docs\Scripts\activate
pip install pypdf pdfplumber python-docx openpyxl python-pptx
```

Install only what the task needs. `pandas` helps for table work; `reportlab` creates PDFs from scratch.

## 2. Look before you change anything

- Copy the original first, and work on the copy: `report.docx` → `report.edited.docx`. Never overwrite the user's
  file unless they asked.
- Inspect it with a short script: page or sheet count, headings, tables, styles, form fields. Print a summary,
  not the whole file.
- For a template, find the placeholders and the styles it uses, and fill those rather than rebuilding the layout.

## 3. Write scripts, not one-liners

Put the work in a small script file (`tools/make_report.py` or a temp folder), run it, read its output, and fix
it. A script can be rerun when the data changes, and it shows what was done.

## 4. Check the result

- Open what you wrote with the same library and print its structure: the right number of pages, rows, slides; the
  text where you expect it.
- For PDFs, extract the text again; for spreadsheets, read back the formulas and a few computed cells.
- Formulas in `.xlsx` written by openpyxl are not calculated until Excel or LibreOffice opens the file; say so, or
  calculate with LibreOffice headless (`soffice --headless --convert-to xlsx`) when the values matter.
- If LibreOffice is installed, converting to PDF (`soffice --headless --convert-to pdf file.docx`) is a quick way
  to see the layout.

## Report

What you read or produced (file paths), how you checked it, and any limits (fonts that may differ, formulas not
recalculated, scanned pages without text).
