# Excel (.xlsx)

## Read

```python
from openpyxl import load_workbook
wb = load_workbook("in.xlsx", data_only=True)   # data_only: cached values instead of formulas
for ws in wb.worksheets:
    print(ws.title, ws.dimensions)
    for row in ws.iter_rows(min_row=1, max_row=5, values_only=True):
        print(row)
```

- `data_only=True` gives the values Excel last saved; a file never opened in Excel has none (`None`). Load twice
  (with and without) to see both the formulas and their values.
- For analysis, `pandas.read_excel("in.xlsx", sheet_name=None)` reads every sheet into DataFrames.

## Write and edit

```python
from openpyxl import Workbook
from openpyxl.styles import Font
wb = Workbook()
ws = wb.active
ws.title = "Sales"
ws.append(["Region", "Q1", "Q2", "Total"])
for r in [("North", 120, 135), ("South", 98, 110)]:
    ws.append([*r, None])
for row in range(2, ws.max_row + 1):
    ws[f"D{row}"] = f"=SUM(B{row}:C{row})"     # keep formulas, so the sheet stays live
ws["A1"].font = Font(bold=True)
ws.freeze_panes = "A2"
wb.save("out.xlsx")
```

- Write formulas for anything derived, rather than computed numbers, so the user can change inputs.
- Loading and saving with openpyxl drops some features (pivot tables, charts made in Excel, macros in .xlsm unless
  `keep_vba=True`). Warn the user, and edit a copy.
- Formulas are calculated when the file is opened in Excel or LibreOffice, not by openpyxl. To get values now:
  `soffice --headless --convert-to xlsx --outdir out/ out.xlsx`, then read with `data_only=True`.
- Number formats: `cell.number_format = "#,##0.00"`; dates are Python `datetime` values.
