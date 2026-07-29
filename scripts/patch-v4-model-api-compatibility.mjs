import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = resolve(root, 'worker/src/media-search-multisource-v4-runtime.generated.js');

export async function patchV4ModelApiCompatibility() {
  let source = await readFile(runtimePath, 'utf8');
  const start = source.indexOf('async function callGeminiStructured({ parts, schema, env, maxOutputTokens, googleSearch }) {');
  const end = source.indexOf('\nfunction normalizeGroundedBrief(result, altTexts, label, imageId) {', start);
  if (start < 0 || end < 0) throw new Error('Could not locate V4 Gemini call function.');

  const replacement = `async function callGeminiStructured({ parts, schema, env, maxOutputTokens, googleSearch }) {
  const configuredModel = typeof env.GEMINI_MODEL === 'string' && env.GEMINI_MODEL.trim()
    ? env.GEMINI_MODEL.trim()
    : DEFAULT_GEMINI_MODEL;
  const modelCandidates = uniqueGeminiModels([
    configuredModel,
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash',
    'gemini-3.1-flash-lite'
  ]);
  const requestParts = googleSearch
    ? [{
        text: [
          'After completing Google Search grounding, return only valid JSON.',
          'Do not include Markdown fences or explanatory text.',
          \`Required JSON schema: \${JSON.stringify(schema)}\`,
          parts?.[0]?.text || ''
        ].join('\\n')
      }, ...parts.slice(1)]
    : parts;
  const legacySchema = JSON.parse(JSON.stringify(schema, (key, value) => (
    key === 'additionalProperties' ? undefined : value
  )));
  const failures = [];

  for (let index = 0; index < modelCandidates.length; index += 1) {
    const model = modelCandidates[index];
    const endpoint = \`https://generativelanguage.googleapis.com/v1beta/models/\${encodeURIComponent(model)}:generateContent\`;
    const generationConfig = { maxOutputTokens };
    if (!googleSearch) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = legacySchema;
    }
    const body = {
      contents: [{ role: 'user', parts: requestParts }],
      generationConfig
    };
    if (googleSearch) body.tools = [{ google_search: {} }];

    const response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      failures.push(\`\${model}: HTTP \${response.status}\${detail ? \` \${detail.slice(0, 520)}\` : ''}\`);
      const formatRejected = response.status === 400
        && /response.?format|response.?mime|response.?schema|mime.?type|additionalProperties/i.test(detail);
      const retryable = response.status === 429 || response.status >= 500 || formatRejected;
      if (!retryable) break;
      if (index < modelCandidates.length - 1) await delay(250 * (2 ** Math.min(index, 3)));
      continue;
    }

    const payload = await response.json();
    const candidate = payload?.candidates?.[0];
    const responseText = (candidate?.content?.parts || [])
      .map((part) => typeof part?.text === 'string' ? part.text : '')
      .join(' ')
      .trim();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      const objectStart = responseText.indexOf('{');
      const objectEnd = responseText.lastIndexOf('}');
      if (objectStart >= 0 && objectEnd > objectStart) {
        try {
          data = JSON.parse(responseText.slice(objectStart, objectEnd + 1));
        } catch {
        }
      }
      if (!data) {
        failures.push(\`\${model}: response was not valid JSON\`);
        if (index < modelCandidates.length - 1) continue;
        break;
      }
    }
    return {
      data,
      grounding: extractGrounding(candidate?.groundingMetadata),
      model
    };
  }

  throw new Error(\`Gemini models unavailable: \${failures.join(' | ')}\`);
}
`;

  source = `${source.slice(0, start)}${replacement}${source.slice(end)}`;
  await writeFile(runtimePath, source, 'utf8');
  return runtimePath;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await patchV4ModelApiCompatibility();
  console.log('Patched V4 with sanitized legacy generateContent schema fields and 2.0 fallbacks.');
}
