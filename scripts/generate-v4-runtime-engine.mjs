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
    "const USER_AGENT = 'LecturePublisherMultiSourceSearch/4.2 (https://github.com/hatemkhaleefah3-ui/smoking)';",
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
    '    const groundedResponse = await createGroundedVisualBrief({ altTexts, imageId, label, searchRun }, env);\n    const grounded = normalizeGroundedBrief(groundedResponse, altTexts, label, imageId);',
    `    const groundedResponse = await createGroundedVisualBrief({ altTexts, imageId, label, searchRun }, env);
    const geminiModelsUsed = new Set();
    if (groundedResponse?.model) geminiModelsUsed.add(groundedResponse.model);
    const grounded = normalizeGroundedBrief(groundedResponse, altTexts, label, imageId);`,
    'grounding model trace'
  );

  source = replaceRequired(
    source,
    `      const review = await reviewCycleImages({
        cycle,
        query,
        candidates: loadedResult.loaded,
        altTexts,
        imageId,
        label,
        visualBrief: grounded.data.visualBrief,
        keyConcepts: grounded.data.keyConcepts,
        expectedVisualFeatures: grounded.data.expectedVisualFeatures,
        acceptedCount: accepted.size,
        usedQueries: [...usedQueries]
      }, env);`,
    `      const review = await reviewCycleImages({
        cycle,
        query,
        candidates: loadedResult.loaded,
        altTexts,
        imageId,
        label,
        visualBrief: grounded.data.visualBrief,
        keyConcepts: grounded.data.keyConcepts,
        expectedVisualFeatures: grounded.data.expectedVisualFeatures,
        acceptedCount: accepted.size,
        usedQueries: [...usedQueries]
      }, env);
      if (review.model) geminiModelsUsed.add(review.model);`,
    'review model trace'
  );

  source = replaceRequired(
    source,
    "      engine: 'multi-source-v4',",
    "      engine: 'multi-source-v4-runtime',\n      geminiModelsUsed: [...geminiModelsUsed],",
    'runtime engine label and models'
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
    const quotaExhausted = /(?:429|RESOURCE_EXHAUSTED|quota|rate limit)/i.test(message);
    console.warn(JSON.stringify({
      event: 'multisource_v4_runtime_failure',
      message,
      quotaExhausted
    }));
    return Response.json({
      engine: 'multi-source-v4-runtime',
      diagnosticFailure: input?.diagnosticMode === true,
      quotaExhausted,
      retryable: quotaExhausted || /(?:500|502|503|504|timeout|aborted)/i.test(message),
      images: [],
      imageResults: [],
      usefulCount: 0,
      error: quotaExhausted
        ? 'Gemini search quota is temporarily exhausted. No fallback images were returned.'
        : message,
      diagnosticError: input?.diagnosticMode === true ? message : undefined
    }, {
      status: quotaExhausted ? 503 : 502,
      headers: { 'Cache-Control': 'no-store' }
    });
  }`,
    'never use irrelevant legacy fallback'
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
    `  const model = typeof env.GEMINI_MODEL === 'string' && env.GEMINI_MODEL.trim()
    ? env.GEMINI_MODEL.trim()
    : DEFAULT_GEMINI_MODEL;
  const endpoint = \`https://generativelanguage.googleapis.com/v1beta/models/\${encodeURIComponent(model)}:generateContent\`;`,
    `  const configuredModel = typeof env.GEMINI_MODEL === 'string' && env.GEMINI_MODEL.trim()
    ? env.GEMINI_MODEL.trim()
    : DEFAULT_GEMINI_MODEL;
  const modelCandidates = uniqueGeminiModels([
    configuredModel,
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite'
  ]);`,
    'Gemini model candidates'
  );

  source = replaceRequired(
    source,
    `  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(\`Gemini returned \${response.status}.\`);
  const payload = await response.json();`,
    `  let response = null;
  let selectedModel = '';
  const failures = [];
  for (let index = 0; index < modelCandidates.length; index += 1) {
    const model = modelCandidates[index];
    const endpoint = \`https://generativelanguage.googleapis.com/v1beta/models/\${encodeURIComponent(model)}:generateContent\`;
    response = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
      body: JSON.stringify(body)
    });
    if (response.ok) {
      selectedModel = model;
      break;
    }
    const detail = await response.text().catch(() => '');
    failures.push(\`\${model}: HTTP \${response.status}\${detail ? \` \${detail.slice(0, 420)}\` : ''}\`);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable) break;
    if (index < modelCandidates.length - 1) await delay(250 * (2 ** index));
  }
  if (!response?.ok || !selectedModel) {
    throw new Error(\`Gemini models unavailable: \${failures.join(' | ')}\`);
  }
  const payload = await response.json();`,
    'Gemini quota failover loop'
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

  source = replaceRequired(
    source,
    '  return { data, grounding: extractGrounding(candidate?.groundingMetadata) };',
    '  return { data, grounding: extractGrounding(candidate?.groundingMetadata), model: selectedModel };',
    'selected Gemini model result'
  );

  source = replaceRequired(
    source,
    `  return {
    decisions: normalizeStrictDecisions(result.data?.decisions, context.candidates.length),
    nextQuery: cleanQuery(result.data?.nextQuery)
  };`,
    `  return {
    decisions: normalizeStrictDecisions(result.data?.decisions, context.candidates.length),
    nextQuery: cleanQuery(result.data?.nextQuery),
    model: result.model
  };`,
    'review selected model result'
  );

  source = replaceRequired(
    source,
    'async function fetchWithTimeout(url, options) {',
    `function uniqueGeminiModels(values) {
  const output = [];
  const seen = new Set();
  for (const value of values) {
    const model = typeof value === 'string' ? value.trim() : '';
    if (!model || seen.has(model)) continue;
    seen.add(model);
    output.push(model);
  }
  return output;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function fetchWithTimeout(url, options) {`,
    'Gemini failover helpers'
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
  console.log('Generated quota-resilient V4 media engine.');
}
