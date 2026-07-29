import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = resolve(root, 'worker/src/media-search-multisource-v4.js');
const outputPath = resolve(root, 'worker/src/media-search-multisource-v4-runtime.generated.js');

export async function generateV4RuntimeEngine() {
  let source = await readFile(sourcePath, 'utf8');

  source = replaceRequired(
    source,
    "const USER_AGENT = 'LecturePublisherMultiSourceSearch/4.0 (https://github.com/hatemkhaleefah3-ui/smoking)';",
    "const USER_AGENT = 'LecturePublisherMultiSourceSearch/4.1 (https://github.com/hatemkhaleefah3-ui/smoking)';",
    'runtime user agent'
  );

  source = replaceRequired(
    source,
    'export async function handleMultiSourceMediaSearchV4(request, env) {',
    'export async function handleMultiSourceMediaSearchV4Runtime(request, env) {',
    'runtime handler name'
  );

  source = replaceRequired(
    source,
    "      engine: 'multi-source-v4',",
    "      engine: 'multi-source-v4-runtime',",
    'runtime engine label'
  );

  source = replaceRequired(
    source,
    "      event: 'multisource_v4_fallback',",
    "      event: 'multisource_v4_runtime_fallback',",
    'runtime fallback event'
  );

  source = replaceRequired(
    source,
    `  } catch (error) {
    console.warn(JSON.stringify({
      event: 'multisource_v4_runtime_fallback',
      message: error instanceof Error ? error.message : String(error)
    }));
    return null;
  }`,
    `  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(JSON.stringify({
      event: 'multisource_v4_runtime_fallback',
      message
    }));
    if (input?.diagnosticMode === true) {
      return Response.json({
        engine: 'multi-source-v4-runtime',
        diagnosticFailure: true,
        error: message
      }, {
        status: 502,
        headers: { 'Cache-Control': 'no-store' }
      });
    }
    return null;
  }`,
    'diagnostic runtime failure response'
  );

  source = replaceRequired(
    source,
    `  const body = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      maxOutputTokens,
      responseFormat: { text: { mimeType: 'application/json', schema } }
    }
  };
  if (googleSearch) body.tools = [{ google_search: {} }];`,
    `  const requestParts = googleSearch
    ? [{
        text: [
          'After completing Google Search grounding, return only valid JSON.',
          'Do not include Markdown fences or explanatory text.',
          \`Required JSON schema: \${JSON.stringify(schema)}\`,
          parts?.[0]?.text || ''
        ].join('\\n')
      }, ...parts.slice(1)]
    : parts;
  const generationConfig = googleSearch
    ? { maxOutputTokens }
    : {
        maxOutputTokens,
        responseFormat: { text: { mimeType: 'application/json', schema } }
      };
  const body = {
    contents: [{ role: 'user', parts: requestParts }],
    generationConfig
  };
  if (googleSearch) body.tools = [{ google_search: {} }];`,
    'grounding without unsupported structured response format'
  );

  source = replaceRequired(
    source,
    '  if (!response.ok) throw new Error(`Gemini returned ${response.status}.`);',
    `  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(\`Gemini returned \${response.status}\${detail ? \`: \${detail.slice(0, 500)}\` : '.'}\`);
  }`,
    'Gemini response detail'
  );

  source = replaceRequired(
    source,
    `  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error('Gemini did not return the required structured result.');
  }`,
    `  let data;
  try {
    data = JSON.parse(responseText);
  } catch {
    const start = responseText.indexOf('{');
    const end = responseText.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        data = JSON.parse(responseText.slice(start, end + 1));
      } catch {
      }
    }
    if (!data) throw new Error('Gemini did not return the required structured result.');
  }`,
    'grounded JSON extraction'
  );

  await writeFile(outputPath, source, 'utf8');
  return outputPath;
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Could not generate V4 runtime engine: ${label} source changed.`);
  return source.replace(search, replacement);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateV4RuntimeEngine();
  console.log('Generated live-compatible V4 media engine.');
}
