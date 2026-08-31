# Covenant review brief — sources

Regenerate `../BSVA-Covenant-Review-Brief.docx` from these.

```bash
# 1. diagrams -> PNG (scale 3 keeps text crisp when scaled to page width)
npx -y @mermaid-js/mermaid-cli -i fig1.mmd -o fig1.png -c cfg.json -b white -s 3
npx -y @mermaid-js/mermaid-cli -i fig2.mmd -o fig2.png -c cfg.json -b white -s 3
npx -y @mermaid-js/mermaid-cli -i fig3.mmd -o fig3.png -c cfg.json -b white -s 3

# 2. document -> ../BSVA-Covenant-Review-Brief.docx
python3 gen.py
```

Two layout constraints, both learned the hard way:

- **Aspect ratio decides legibility.** A diagram wider than ~3:1 renders its text at
  4-6pt once scaled to the 6.3in content width. `fig3` was originally 7.3:1 (`graph LR`)
  and had to be reflowed to `graph TD`. Check `width/height` before embedding.
- **The cover page fits four lines.** A title that wraps to two lines pushes the date off
  onto page 2, which looks like a bug. Version and date are merged onto one line for that
  reason; if you lengthen the title, shorten something else.
