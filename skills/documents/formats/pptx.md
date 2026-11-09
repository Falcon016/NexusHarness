# PowerPoint (.pptx)

## Read

```python
from pptx import Presentation
prs = Presentation("in.pptx")
for i, slide in enumerate(prs.slides, 1):
    print(f"--- slide {i} ({slide.slide_layout.name}) ---")
    for shape in slide.shapes:
        if shape.has_text_frame and shape.text_frame.text.strip():
            print(f"[{shape.shape_type}] {shape.text_frame.text}")
    if slide.has_notes_slide:
        print("notes:", slide.notes_slide.notes_text_frame.text)
```

## Create from the deck's own layouts

```python
from pptx import Presentation
from pptx.util import Pt
prs = Presentation("template.pptx")          # or Presentation() for the plain default
for i, layout in enumerate(prs.slide_layouts):
    print(i, layout.name, [p.placeholder_format.type for p in layout.placeholders])

slide = prs.slides.add_slide(prs.slide_layouts[1])   # "Title and Content" in most templates
slide.shapes.title.text = "Results"
body = slide.placeholders[1].text_frame
body.text = "Revenue up 12%"
p = body.add_paragraph(); p.text = "Churn down to 3%"; p.level = 1
prs.save("out.pptx")
```

- Fill the template's placeholders rather than placing text boxes by hand: the deck keeps its fonts, colours and
  positions.
- One idea per slide, a few short lines each. Put detail in the speaker notes
  (`slide.notes_slide.notes_text_frame.text = ...`).
- Images: `slide.shapes.add_picture("chart.png", left, top, width=...)`. Make charts with matplotlib and insert them
  as images, or with `slide.shapes.add_chart` for native, editable charts.
- python-pptx cannot render slides. To check the look, convert with LibreOffice
  (`soffice --headless --convert-to pdf out.pptx`) and look at the PDF.
