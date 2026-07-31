# Adaptive feedback-ranked image search

This feature adds a second image search field beneath the existing Search workspace.

## 1. Server route

The Advanced Mode Pages Worker handles the following endpoints:

- `POST /api/image-search`
- `POST /api/image-search/feedback`

Search request:

```json
{
  "query": "glycine",
  "topic": null,
  "retry": false,
  "excludeUrls": []
}
```

When Wikidata finds multiple categories, the first response contains:

```json
{
  "requiresTopic": true,
  "query": "glycine",
  "topics": [
    {
      "id": "chemical-structure",
      "label": "Chemical structure",
      "querySuffix": "chemical structure molecule diagram"
    }
  ]
}
```

Submit the chosen topic object with the next search request. The Worker appends `querySuffix` to the external provider query and adds the topic label/id to every result.

Feedback request:

```json
{
  "imageUrl": "https://example.org/image.jpg",
  "source": "wikimedia",
  "queryTerm": "glycine",
  "topic": "Chemical structure",
  "rating": 1
}
```

Use `1` for an upvote and `-1` for a downvote.

## 2. D1 migration

The migration is stored at:

```text
migrations/0003_image_feedback.sql
```

Apply it locally:

```bash
npx wrangler d1 migrations apply lecture-links --local
```

Apply it to production:

```bash
npx wrangler d1 migrations apply lecture-links --remote
```

The Worker also uses `CREATE TABLE IF NOT EXISTS` as a deployment safeguard, but the migration should remain the tracked source of truth.

## 3. External sources

The Worker queries these sources concurrently with server-side `fetch`:

- Wikimedia Commons Action API
- Openverse Images API
- NLM Open-i search API

One provider failing does not fail the complete search. The response includes a `sourceStatus` entry for each provider.

## 4. Wikidata ambiguity detection

Before querying image providers, the Worker calls:

1. `wbsearchentities`
2. `wbgetentities` for entity claims and descriptions
3. `wbgetentities` again to resolve `P31` (`instance of`) labels

The instance labels and entity descriptions are grouped into up to four user-facing topic choices. A single clear topic is selected automatically.

## 5. D1 ranking behavior

For the exact query and topic, the Worker aggregates feedback by `image_url`:

- aggregate score greater than zero: result is boosted
- aggregate score less than zero: result is removed
- no feedback: provider relevance order is preserved

The browser additionally sends URLs downvoted during the current session in `excludeUrls` when Retry is selected.

## 6. R2 metadata cache

Successful merged result metadata is cached for seven days under:

```text
image-search-cache/v1/<sha256>.json
```

Only metadata is cached, not image bytes. The Worker uses `IMAGE_SEARCH_CACHE` when configured, otherwise it safely reuses the existing `LECTURES` R2 bucket with the separate prefix above.

The default TTL is configured in `wrangler.jsonc`:

```json
"IMAGE_SEARCH_CACHE_TTL_SECONDS": "604800"
```

## 7. Frontend files

- `adaptive-image-search.js` creates the separate search panel, ambiguity choices, results, votes and Retry behavior.
- `adaptive-image-search.css` styles the panel and responsive result grid.
- `studio-refinements.js` loads the component.
- `styles.css` imports the component stylesheet.
- `scripts/build.mjs` copies both assets to `dist`.

## 8. Validation

Run the complete suite:

```bash
npm test
```

Focused tests:

```bash
node scripts/test-adaptive-image-search.mjs
npm run build
node scripts/test-adaptive-image-search-assets.mjs
```
