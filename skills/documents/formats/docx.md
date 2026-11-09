# Word (.docx)

## Read

```python
from docx import Document
d = Document("in.docx")
for p in d.paragraphs:
    if p.text.strip():
        print(f"[{p.style.name}] {p.text}")
for t in d.tables:
    for row in t.rows:
        print([c.text for c in row.cells])
```

Headers and footers: `d.sections[0].header.paragraphs`. Comments and tracked changes are not exposed by
python-docx; they are in the XML (`word/comments.xml`, `w:ins`/`w:del` in `word/document.xml`): unzip and read
them if the task needs them.

## Edit

- Replacing text: a paragraph's text is split into _runs_ by formatting, so a placeholder like `{{name}}` can be
  spread over several runs. Replace within runs when it is whole there; otherwise set the first run's text to the
  new paragraph text and clear the others (this keeps the first run's formatting).
- Use the document's own styles (`p.style = d.styles["Heading 2"]`) instead of setting fonts by hand.
- Insert after a paragraph: `p._p.addnext(new_p._p)` (python-docx only appends at the end otherwise).

## Create

```python
from docx import Document
from docx.shared import Pt
d = Document()                      # or Document("template.docx") to keep its styles
d.add_heading("Meeting notes", 1)
d.add_paragraph("Decisions", style="List Bullet")
t = d.add_table(rows=1, cols=2, style="Table Grid")
t.rows[0].cells[0].text, t.rows[0].cells[1].text = "Owner", "Task"
d.save("out.docx")
```

Starting from the user's template keeps their fonts, margins and numbering, which is usually what they want.
