# Lecture HTML Generator

A dependency-free browser app that converts structured lecture JSON into a polished, reusable, self-contained HTML document.

## What is included

- `templates/lecture-template.html` — the reusable standalone HTML template.
- `schema/lecture-output.schema.json` — the formal ChatGPT output contract.
- `prompts/lecture-to-json.txt` — a ready-to-use prompt for converting an attached plain-text lecture file into the required JSON.
- `index.html` — the import, preview, and export page.
- `app.js` — validation, safe rendering, preview, and download logic.
- `styles.css` — the website interface styles.
- `examples/lecture-output.example.json` — a valid example input.

## Workflow

1. Save the lecture as a plain-text `.txt` file.
2. Attach the file to ChatGPT.
3. Paste the prompt from `prompts/lecture-to-json.txt`.
4. Save ChatGPT's JSON-only response as a `.json` file.
5. Open this website and import the JSON file.
6. Review the preview and select **Download HTML**.

The downloaded HTML is self-contained: its layout and CSS are embedded, so it can be opened, shared, hosted, or printed without this app.

## Run locally

Browsers do not normally allow `fetch()` from a page opened with a `file://` URL. Serve the repository with any small static server instead:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

## Publish with GitHub Pages

After the files are on the default branch:

1. Open the repository's **Settings**.
2. Open **Pages**.
3. Under **Build and deployment**, select **Deploy from a branch**.
4. Select the default branch and the `/ (root)` folder.
5. Save.

## Input format

Every imported file must contain:

```json
{
  "schemaVersion": "1.0",
  "document": {
    "title": "...",
    "language": "en",
    "direction": "ltr",
    "course": "",
    "lectureNumber": "",
    "lecturer": "",
    "date": "",
    "summary": "",
    "keywords": [],
    "sections": []
  }
}
```

See `schema/lecture-output.schema.json` for the exact rules and `examples/lecture-output.example.json` for a complete example.

Supported content blocks are paragraphs, level 3/4 headings, ordered or unordered lists, quotations, callouts, tables, and code blocks.

## Safety and privacy

- Imported JSON is processed locally in the browser.
- The app does not upload lecture content.
- Imported text is HTML-escaped before it is inserted into the generated document.
- The preview runs inside a sandboxed iframe.
