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
    'provider grounding fallback'
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
    `      let review = null;
      let reviewFailure = groundingFailure;
      if (!groundingUnavailable) {
        try {
          review = await reviewCycleImages({
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
        } catch (error) {
          reviewFailure = error instanceof Error ? error.message : String(error);
          if (!/(?:Gemini models unavailable|429|RESOURCE_EXHAUSTED|quota|rate limit)/i.test(reviewFailure)) throw error;
        }
      }

      if (groundingUnavailable || reviewFailure) {
        const quotaExhausted = groundingQuotaExhausted
          || /(?:429|RESOURCE_EXHAUSTED|quota|rate limit)/i.test(reviewFailure);
        const fallbackRanked = loadedResult.loaded
          .map((candidate, index) => {
            const relevance = providerFallbackRelevance(candidate, [label, ...altTexts]);
            return {
              ...stripReviewData(candidate),
              resemblanceScore: relevance.score,
              visualCoverage: 0,
              matchedFeatures: relevance.matchedTerms,
              acceptanceReason: relevance.matchedTerms.length
                ? 'Gemini visual review unavailable; provider metadata matched: ' + relevance.matchedTerms.join(', ') + '.'
                : 'Gemini visual review unavailable; selected from the provider relevance order.',
              acceptedCycle: cycle,
              acceptedOrder: index
            };
          })
          .sort((a, b) => (b.resemblanceScore - a.resemblanceScore)
            || (SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source))
            || (a.acceptedOrder - b.acceptedOrder));
        const imageResults = fallbackRanked.map(publicResult);
        const fallbackAvailable = imageResults.length > 0;

        cycles.push({
          cycle,
          query,
          resultPage,
          discovered: discovery.candidates.length,
          loadedForReview: loadedResult.loaded.length,
          visuallyReviewed: 0,
          accepted: fallbackAvailable ? imageResults.length : 0,
          totalAccepted: fallbackAvailable ? imageResults.length : 0,
          sources: countSources(discovery.candidates),
          loadedSources: countSources(loadedResult.loaded),
          providerStatus: discovery.providers,
          loadFailures: loadedResult.failures
        });

        return Response.json({
          engine: 'multi-source-v4-runtime',
          diagnosticFailure: !fallbackAvailable,
          degraded: fallbackAvailable,
          quotaExhausted,
          retryable: quotaExhausted || /(?:500|502|503|504|timeout|aborted)/i.test(reviewFailure),
          discoveryCompleted: true,
          visualReview: false,
          fallbackMode: fallbackAvailable ? 'provider-text-ranking' : '',
          multiSource: true,
          images: imageResults.map((item) => item.url),
          imageResults,
          usefulCount: imageResults.length,
          intentSummary: grounded.data.visualBrief,
          searchRounds: cycles.length,
          targetReached: fallbackAvailable,
          searchRun,
          resultPage,
          excludedPrevious: excludedUrls.size,
          allowedLicenses: ['CC0', 'Public Domain', 'CC BY', 'CC BY-SA', 'CC BY-NC', 'CC BY-NC-SA'],
          googleSearchGrounding: false,
          groundingQueries: [],
          groundingSources: [],
          searchedQueries: cycles.map((item) => item.query),
          sourceCounts: countSources(fallbackRanked),
          discoveredSourceCounts: countSources(discovery.candidates),
          loadedSourceCounts: countSources(loadedResult.loaded),
          providerDiagnostics,
          cycles,
          stoppedReason: fallbackAvailable
            ? 'gemini-unavailable-provider-fallback'
            : 'gemini-unavailable-no-provider-images',
          warning: fallbackAvailable
            ? 'Gemini visual review is temporarily unavailable. Showing source-balanced provider results ranked by query and metadata.'
            : undefined,
          error: fallbackAvailable
            ? undefined
            : (quotaExhausted
                ? 'Gemini search quota is temporarily exhausted and no provider image could be loaded.'
                : 'Gemini visual review is unavailable and no provider image could be loaded.'),
          diagnosticError: input?.diagnosticMode === true ? reviewFailure : undefined,
          geminiModelsUsed: [...geminiModelsUsed]
        }, {
          status: fallbackAvailable ? 200 : (quotaExhausted ? 503 : 502),
          headers: { 'Cache-Control': 'no-store' }
        });
      }

      if (review.model) geminiModelsUsed.add(review.model);`,
    'provider fallback response when Gemini is unavailable'
  );

  source = replaceRequired(
    source,
    `function createProviderDiagnostics() {`,
    `const PROVIDER_FALLBACK_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'is', 'of', 'on', 'or', 'the', 'to', 'with',
  'diagram', 'educational', 'figure', 'image', 'illustration', 'labeled', 'labelled', 'medical', 'overview', 'pathway',
  'photo', 'picture', 'process', 'reaction', 'reactions', 'showing', 'shows', 'synthesis'
]);

function providerFallbackTokens(value) {
  return (normalize(value).match(/[\\p{L}\\p{N}]+/gu) || [])
    .filter((token) => token.length >= 3 && token.length <= 40 && !PROVIDER_FALLBACK_STOP_WORDS.has(token));
}

function providerFallbackRelevance(candidate, intentTexts) {
  const intentTokens = new Set((intentTexts || []).flatMap(providerFallbackTokens));
  const metadata = [candidate?.title, candidate?.description, candidate?.attribution, candidate?.creator]
    .filter(Boolean)
    .join(' ');
  const metadataTokens = new Set(providerFallbackTokens(metadata));
  const matchedTerms = [...intentTokens].filter((token) => metadataTokens.has(token)).slice(0, 8);
  const label = normalize(intentTexts?.[0]);
  const normalizedMetadata = normalize(metadata);
  const phraseBoost = label && normalizedMetadata.includes(label) ? 18 : 0;
  return {
    score: Math.min(79, 45 + phraseBoost + (matchedTerms.length * 6)),
    matchedTerms
  };
}

function createProviderDiagnostics() {`,
    'provider text relevance helpers'
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
  console.log('Patched V4 runtime with provider funnel diagnostics and Gemini-quota image fallback.');
}
