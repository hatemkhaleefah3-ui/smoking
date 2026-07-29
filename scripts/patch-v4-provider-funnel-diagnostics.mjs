import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimePath = resolve(root, 'worker/src/media-search-multisource-v4-runtime.generated.js');

export async function patchV4ProviderFunnelDiagnostics() {
  let source = await readFile(runtimePath, 'utf8');

  source = replaceRequired(
    source,
    `    const groundedResponse = await createGroundedVisualBrief({ altTexts, imageId, label, searchRun }, env);
    const geminiModelsUsed = new Set();
    if (groundedResponse?.model) geminiModelsUsed.add(groundedResponse.model);
    const grounded = normalizeGroundedBrief(groundedResponse, altTexts, label, imageId);`,
    `    const geminiModelsUsed = new Set();
    let groundingFailure = '';
    let groundedResponse;
    try {
      groundedResponse = await createGroundedVisualBrief({ altTexts, imageId, label, searchRun }, env);
    } catch (error) {
      if (input?.diagnosticMode !== true) throw error;
      groundingFailure = error instanceof Error ? error.message : String(error);
      groundedResponse = {
        data: {
          visualBrief: altTexts.join(' ').slice(0, 1000),
          keyConcepts: normalizeTexts([label, imageId], 4, 180),
          expectedVisualFeatures: normalizeTexts([label, ...altTexts], 6, 240),
          firstSearchQuery: cleanQuery(label)
        },
        grounding: { used: false, queries: [], sources: [] },
        model: ''
      };
    }
    if (groundedResponse?.model) geminiModelsUsed.add(groundedResponse.model);
    const groundingUnavailable = Boolean(groundingFailure);
    const groundingQuotaExhausted = /(?:429|RESOURCE_EXHAUSTED|quota|rate limit)/i.test(groundingFailure);
    const grounded = normalizeGroundedBrief(groundedResponse, altTexts, label, imageId);`,
    'diagnostic grounding fallback'
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
      }, env);
      if (review.model) geminiModelsUsed.add(review.model);`,
    `      if (groundingUnavailable) {
        cycles.push({
          cycle,
          query,
          resultPage,
          discovered: discovery.candidates.length,
          loadedForReview: loadedResult.loaded.length,
          visuallyReviewed: 0,
          accepted: 0,
          totalAccepted: 0,
          sources: countSources(discovery.candidates),
          loadedSources: countSources(loadedResult.loaded),
          providerStatus: discovery.providers,
          loadFailures: loadedResult.failures
        });
        return Response.json({
          engine: 'multi-source-v4-runtime',
          diagnosticFailure: true,
          quotaExhausted: groundingQuotaExhausted,
          retryable: groundingQuotaExhausted || /(?:500|502|503|504|timeout|aborted)/i.test(groundingFailure),
          discoveryCompleted: true,
          visualReview: false,
          multiSource: true,
          images: [],
          imageResults: [],
          usefulCount: 0,
          intentSummary: grounded.data.visualBrief,
          searchRounds: cycles.length,
          targetReached: false,
          searchRun,
          resultPage,
          excludedPrevious: excludedUrls.size,
          allowedLicenses: ['CC0', 'Public Domain', 'CC BY', 'CC BY-SA', 'CC BY-NC', 'CC BY-NC-SA'],
          googleSearchGrounding: false,
          groundingQueries: [],
          groundingSources: [],
          searchedQueries: cycles.map((item) => item.query),
          sourceCounts: {},
          discoveredSourceCounts: countSources(discovery.candidates),
          loadedSourceCounts: countSources(loadedResult.loaded),
          providerDiagnostics,
          cycles,
          stoppedReason: 'gemini-unavailable-before-visual-review',
          error: groundingQuotaExhausted
            ? 'Gemini search quota is temporarily exhausted. Provider discovery completed, but no image was accepted without visual review.'
            : 'Gemini visual grounding is unavailable. Provider discovery completed, but no image was accepted without visual review.',
          diagnosticError: groundingFailure,
          geminiModelsUsed: [...geminiModelsUsed]
        }, {
          status: groundingQuotaExhausted ? 503 : 502,
          headers: { 'Cache-Control': 'no-store' }
        });
      }

      const review = await reviewCycleImages({
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
    'provider funnel response before visual review'
  );

  await writeFile(runtimePath, source, 'utf8');
  return runtimePath;
}

function replaceRequired(source, search, replacement, label) {
  if (!source.includes(search)) throw new Error(`Could not patch V4 provider diagnostics: ${label} source changed.`);
  return source.replace(search, replacement);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await patchV4ProviderFunnelDiagnostics();
  console.log('Patched V4 runtime to expose provider funnel diagnostics.');
}
