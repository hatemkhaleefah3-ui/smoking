import {
  DEPLOYMENT_COMMIT_SHA,
  FIX_COMMIT_SHA,
  DEPLOYMENT_METADATA_GENERATED_AT
} from './deployment-meta.generated.js';

const DIAGNOSTIC_TOKEN = '9c593829f5c04b3e9ffb86724c4c3b75';
const DEPLOYMENT_PATH = `/api/diagnostics/${DIAGNOSTIC_TOKEN}/deployment`;
const SEARCH_PATH = `/api/diagnostics/${DIAGNOSTIC_TOKEN}/media-search`;

const DIAGNOSTIC_PAYLOAD = {
  intentSearch: true,
  strictRelevance: true,
  diagnosticMode: true,
  imageId: 'img-live-albinism-melanin-pathway',
  label: 'Albinism melanin synthesis pathway',
  altTexts: [
    'Medical pathway diagram showing tyrosinase converting tyrosine through DOPA into melanin, with the blocked enzyme step responsible for albinism.',
    'Educational comparison of normal melanin production and reduced pigmentation caused by tyrosinase deficiency in oculocutaneous albinism.'
  ],
  searchRun: 0,
  excludedUrls: []
};

export async function handleLiveMediaDiagnostics(request, env, url, routeMediaSearch, runtimeRelease) {
  if (request.method !== 'GET') return null;

  if (url.pathname === DEPLOYMENT_PATH) {
    return jsonResponse({
      deploymentCommitSha: DEPLOYMENT_COMMIT_SHA,
      requiredFixCommitSha: FIX_COMMIT_SHA,
      metadataGeneratedAt: DEPLOYMENT_METADATA_GENERATED_AT,
      runtimeRelease,
      routeOrder: [
        'multi-source-v4-runtime',
        'multi-source-v4',
        'multi-source-v3',
        'multi-source-v2',
        'multi-source-legacy',
        'visual-cycle',
        'relevance',
        'enhanced-wikimedia'
      ]
    });
  }

  if (url.pathname !== SEARCH_PATH) return null;

  const routeTrace = [];
  const internalRequest = new Request(new URL('/api/search', request.url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(DIAGNOSTIC_PAYLOAD)
  });
  const startedAt = Date.now();
  const response = await routeMediaSearch(internalRequest, env, routeTrace);
  const responseText = await response.clone().text();
  let responseBody;
  try {
    responseBody = JSON.parse(responseText);
  } catch {
    responseBody = { nonJsonBody: responseText.slice(0, 2000) };
  }

  const deployment = {
    deploymentCommitSha: DEPLOYMENT_COMMIT_SHA,
    requiredFixCommitSha: FIX_COMMIT_SHA,
    metadataGeneratedAt: DEPLOYMENT_METADATA_GENERATED_AT,
    runtimeRelease
  };
  const elapsedMs = Date.now() - startedAt;
  if (url.searchParams.get('compact') === '1') {
    return jsonResponse({
      deployment,
      routeTrace,
      liveResponse: {
        status: response.status,
        cacheControl: response.headers.get('cache-control') || '',
        elapsedMs,
        body: compactBody(responseBody)
      }
    });
  }

  return jsonResponse({
    deployment,
    request: DIAGNOSTIC_PAYLOAD,
    routeTrace,
    liveResponse: {
      status: response.status,
      cacheControl: response.headers.get('cache-control') || '',
      elapsedMs,
      body: responseBody
    }
  });
}

function compactBody(body) {
  const cycles = Array.isArray(body?.cycles) ? body.cycles.map((cycle) => ({
    cycle: cycle?.cycle,
    query: cycle?.query,
    resultPage: cycle?.resultPage,
    discovered: cycle?.discovered,
    visuallyReviewed: cycle?.visuallyReviewed,
    reviewedSources: cycle?.reviewedSources,
    accepted: cycle?.accepted,
    totalAccepted: cycle?.totalAccepted,
    sources: cycle?.sources,
    providerStatus: cycle?.providerStatus
  })) : [];
  const imageResults = Array.isArray(body?.imageResults) ? body.imageResults.map((item) => ({
    source: item?.source,
    title: item?.title,
    resemblanceScore: item?.resemblanceScore,
    visualCoverage: item?.visualCoverage,
    matchedFeatures: item?.matchedFeatures,
    acceptanceReason: item?.acceptanceReason
  })) : [];
  return {
    engine: body?.engine,
    error: body?.error,
    diagnosticError: body?.diagnosticError,
    quotaExhausted: body?.quotaExhausted,
    retryable: body?.retryable,
    googleSearchGrounding: body?.googleSearchGrounding,
    groundingFallback: body?.groundingFallback,
    groundingFailure: body?.groundingFailure,
    geminiModelsUsed: body?.geminiModelsUsed,
    usefulCount: body?.usefulCount,
    stoppedReason: body?.stoppedReason,
    providerDiagnostics: body?.providerDiagnostics,
    sourceCounts: body?.sourceCounts,
    searchedQueries: body?.searchedQueries,
    cycles,
    imageResults
  };
}

function jsonResponse(value) {
  return Response.json(value, {
    headers: {
      'Cache-Control': 'no-store, max-age=0, must-revalidate',
      'X-Lecture-Diagnostic': 'live-media-search-v4-runtime'
    }
  });
}
