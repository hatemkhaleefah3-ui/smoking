# Lecture HTML Generator

A dependency-free browser app that converts structured lecture JSON into reusable lecture pages and lets visitors preview the same content in multiple designs.

## Included designs

- **Classic Academic** — the original clean, print-friendly template.
- **Enhanced Modern** — a modern layout with a sidebar table of contents, objectives, statistics, and rich content blocks.
- **Editorial Journal** — an editorial reading layout with refined typography, a compact contents menu, and decorative section numbering.

## Key files

- `templates/lecture-template.html` — Classic Academic.
- `templates/lecture-template-enhanced.html` — Enhanced Modern.
- `templates/lecture-template-editorial.html` — Editorial Journal.
- `examples/lecture-output.example.json` — the shared schema v2.1 example that works with all three designs.
- `prompts/lecture-to-json.txt` — the prompt to use with a lecture file and the example JSON file.
- `index.html`, `styles.css`, and `app.js` — design selection, JSON validation, rendering, and separate-page preview.

## Workflow

1. Attach the lecture file and `examples/lecture-output.example.json` to ChatGPT.
2. Use `prompts/lecture-to-json.txt`.
3. Download ChatGPT's resulting `.json` file.
4. Open this website and choose a design.
5. Choose the JSON file and select **Build**.
6. Select **Preview** to open only the finished lecture in a new page.
7. Change the design and preview again without rebuilding the JSON.

Before a visitor builds a JSON file, Preview opens the included example lecture in the selected design.

## Supported input

The app supports the original schema v1.0 files and the richer schema v2.1 format. Schema v2.1 adds theme colors, learning objectives, statistics, references, a document glossary, section icons, section summaries, and these richer block types:

- key points
- section summaries
- steps
- comparisons
- timelines
- columns
- formulas
- glossary blocks

The original paragraph, heading, list, quote, callout, table, and code blocks remain supported.

## Run locally

Browsers do not normally allow `fetch()` from a page opened with a `file://` URL. Serve the repository with a static server:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Publish with GitHub Pages

1. Open the repository's **Settings**.
2. Open **Pages**.
3. Under **Build and deployment**, select **Deploy from a branch**.
4. Select the default branch and the `/ (root)` folder.
5. Save.

## Safety and privacy

- Imported JSON is processed locally in the browser.
- The app does not upload lecture content.
- Imported text is HTML-escaped before rendering.
- Theme values are restricted to hexadecimal colors.
- Reference links are restricted to HTTP and HTTPS URLs.
