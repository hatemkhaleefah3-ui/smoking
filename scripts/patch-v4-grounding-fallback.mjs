import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = resolve(root, 'worker/src/media-search-multisource-v4-runtime.generated.js');

export async function patchV4GroundingFallback() {
  let source = await readFile(runtimePath, 'utf8');
  const start = source.indexOf('async function createGroundedVisualBrief(context, env) {');
  const end = source.indexOf('\nasync function reviewCycleImages(context, env) {', start);
  if (start < 0 || end < 0) throw new Error('Could not locate V4 visual-brief function.');

  const replacement = `async function createGroundedVisualBrief(context, env) {
  const prompt = [
    'Use Google Search grounding before answering.',
    'Research authoritative explanations and representative web images for the scientific or educational subject below.',
    'All alt texts describe one intended lecture image. Build one accurate visual brief from all of them.',
    'List concrete required visual features that must be visibly present in a correct image.',
    'Create one concise English keyword query suitable for Wikimedia Commons, Openverse, and Wellcome Collection.',
    context.searchRun > 0
      ? \`This is alternative search run \${context.searchRun}. Use different precise scientific synonyms and collection terminology.\`
      : '',
    \`Visible image label: \${context.label}\`,
    \`Image id: \${context.imageId || 'not provided'}\`,
    \`Alt texts: \${JSON.stringify(context.altTexts)}\`
  ].filter(Boolean).join('\\n');
  const schema = {
    type: 'object',
    properties: {
      visualBrief: { type: 'string' },
      keyConcepts: { type: 'array', items: { type: 'string' } },
      expectedVisualFeatures: { type: 'array', items: { type: 'string' } },
      firstSearchQuery: { type: 'string' }
    },
    required: ['visualBrief', 'keyConcepts', 'expectedVisualFeatures', 'firstSearchQuery'],
    additionalProperties: false
  };

  try {
    return await callGeminiStructured({
      parts: [{ text: prompt }],
      schema,
      env,
      maxOutputTokens: 700,
      googleSearch: true
    });
  } catch (groundingError) {
    const groundingFailure = cleanText(
      groundingError instanceof Error ? groundingError.message : String(groundingError),
      1000
    );
    const fallbackPrompt = [
      'Google Search grounding is unavailable for this request.',
      'Use only the supplied image label and all alt texts to construct a precise visual brief.',
      'Do not invent structures or relationships that are not supported by those texts.',
      prompt
    ].join('\\n');
    const fallback = await callGeminiStructured({
      parts: [{ text: fallbackPrompt }],
      schema,
      env,
      maxOutputTokens: 700,
      googleSearch: false
    });
    return {
      ...fallback,
      groundingFallback: true,
      groundingFailure
    };
  }
}
`;

  source = `${source.slice(0, start)}${replacement}${source.slice(end)}`;
  source = replaceRequired(
    source,
    '      googleSearchGrounding: grounded.grounding.used,',
    `      googleSearchGrounding: grounded.grounding.used,
      groundingFallback: groundedResponse?.groundingFallback === true,
      groundingFailure: input?.diagnosticMode === true ? cleanText(groundedResponse?.groundingFailure, 1000) : undefined,`,
    'grounding response diagnostics'
  );
  source = source.replace(
    "const USER_AGENT = 'LecturePublisherMultiSourceSearch/4.2 (https://github.com/hatemkhaleefah3-ui/smoking)';",
    "const USER_AGENT = 'LecturePublisherMultiSourceSearch/4.3 (https://github.com/hatemkhaleefah3-ui/smoking)';"
  );

  await writeFile(runtimePath, source, 'utf8');
  return runtimePath;
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Could not patch V4 grounding fallback: ${label}.`);
  return source.replace(search, replacement);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await patchV4GroundingFallback();
  console.log('Patched V4 with non-grounded visual-brief fallback.');
}
