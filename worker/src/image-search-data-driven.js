'use strict';

import { searchProviderPool } from './image-search-provider-pool.js';
import { imageSearchErrorResponse } from './image-search-core.js';

const SEARCH_PATH = '/api/image-search';
const FEEDBACK_PATH = '/api/image-search/feedback';
const MAX_QUERY_LENGTH = 160;
const MAX_VISIBLE_RESULTS = 30;
const MAX_FEEDBACK_PROFILES = 500;
const MIN_KEYWORD_FREQUENCY = 2;
const MAX_KEYWORD_OPTIONS = 6;
const MIN_STRICT_FILTER_RESULTS = 3;
const KEYWORD_EXTRACTION_TIMEOUT_MS = 1_500;
const DEFAULT_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;
const CACHE_VERSION = 'v4-data-driven-keywords';
const SIMILARITY_THRESHOLD = 0.28;
const SIMILARITY_PROPAGATION = 0.55;

const schemaPromises = new WeakMap();

const STOPWORDS = new Set(`
  a an and are as at be been being by can could did do does doing during each for from had has have having
  he her hers him his how i if in into is it its itself may might more most much must my no nor not of on once
  only or other our ours out over own same she should so some such than that the their theirs them themselves
  then there these they this those through to too under until up very was we were what when where which while
  who whom why will with would you your yours image images figure figures shown showing show depicts depicted
  view views illustration illustrations diagram diagrams photo photos photograph photographs panel panels
  file files source sources result results example examples using used use study studies article data based
`.split(/\s+/).filter(Boolean));

export async function handleImageSearchRequest(request, env, url = new URL(request.url)) {
  if (url.pathname === FEEDBACK_PATH || url.pathname === `${FEEDBACK_PATH}/`) {
    if (request.method !== 'POST') return methodNotAllowed('POST');
    return saveFeedback(request, env, url);
  }
  if (url.pathname !== SEARCH_PATH && url.pathname !== `${SEARCH_PATH}/`) return null;
  if (request.method !== 'POST') return methodNotAllowed('POST');
  return searchImages(request, env, url);
}

async function searchImages(request, env, url) {
  assertSameOrigin(request, url);
  const input = await readJson(request);
  const query = normalizeText(input?.query, MAX_QUERY_LENGTH);
  if (!query) return json({ error: 'Enter an image search term.' }, 400);

  await ensureImageFeedbackSchema(env.DB);
  const debug = Boolean(input?.debug);
  const retry = Boolean(input?.retry);
  const selectedKeyword = normalizeSelectedKeyword(input?.keyword);
  const cacheBucket = env.IMAGE_SEARCH_CACHE || env.LECTURES || null;
  const cacheKey = await buildPoolCacheKey(query);

  let cacheHit = false;
  let poolPayload = null;
  if (!retry && cacheBucket) {
    poolPayload = await readPoolCache(cacheBucket, cacheKey);
    cacheHit = Boolean(poolPayload);
  }

  if (!poolPayload) {
    poolPayload = await searchProviderPool({ query, debug });
    if (cacheBucket && poolPayload.results.length) {
      await writePoolCache(cacheBucket, cacheKey, poolPayload, cacheTtlSeconds(env));
    }
  }

  const rawPool = Array.isArray(poolPayload.results) ? poolPayload.results : [];
  const extraction = await extractKeywordOptionsWithTimeout(rawPool, query);
  const keywordOptions = extraction.options;
  const annotatedPool = extraction.annotatedResults;
  const chosen = resolveSelectedKeyword(selectedKeyword, keywordOptions);
  const requiresKeyword = !chosen && keywordOptions.length >= 2;

  if (requiresKeyword) {
    return json({
      requiresTopic: false,
      requiresKeyword: true,
      query,
      keywordOptions,
      poolResultCount: rawPool.length,
      cacheHit,
      sourceStatus: poolPayload.sourceStatus || [],
      providerSummary: summarizeProviderState(poolPayload.sourceStatus || []),
      keywordExtraction: extraction.summary,
      ...(debug ? { debugDiagnostics: { providers: poolPayload.diagnostics || [] } } : {})
    });
  }

  const filter = chosen
    ? filterResultPool(annotatedPool, query, chosen)
    : { results: annotatedPool, mode: 'broad-pool', strictCount: annotatedPool.length, fallbackUsed: false };
  const feedbackState = await loadFeedbackState(env.DB);
  const ranked = rankWithFeedback(filter.results, feedbackState, chosen)
    .slice(0, MAX_VISIBLE_RESULTS)
    .map(stripInternalAnalysis);

  return json({
    requiresTopic: false,
    requiresKeyword: false,
    query,
    keyword: chosen,
    keywordOptions,
    keywordExtraction: extraction.summary,
    filter: {
      mode: filter.mode,
      strictCount: filter.strictCount,
      fallbackUsed: filter.fallbackUsed,
      filteredPoolCount: filter.results.length
    },
    cacheHit,
    retry,
    resultCount: ranked.length,
    poolResultCount: rawPool.length,
    results: ranked,
    sourceStatus: poolPayload.sourceStatus || [],
    providerSummary: summarizeProviderState(poolPayload.sourceStatus || []),
    feedbackApplied: feedbackState.hasFeedback,
    feedbackRanking: {
      method: 'persistent-log-weight-with-metadata-similarity',
      hardRemovalThreshold: null,
      similarityThreshold: SIMILARITY_THRESHOLD,
      propagationFactor: SIMILARITY_PROPAGATION
    },
    ...(debug ? { debugDiagnostics: { providers: poolPayload.diagnostics || [] } } : {})
  });
}

async function saveFeedback(request, env, url) {
  assertSameOrigin(request, url);
  await ensureImageFeedbackSchema(env.DB);
  const input = await readJson(request);
  const imageUrl = normalizeHttpsUrl(input?.imageUrl);
  const source = normalizeText(input?.source, 40).toLowerCase();
  const queryTerm = normalizeText(input?.queryTerm, MAX_QUERY_LENGTH).toLowerCase();
  const topic = normalizeText(input?.topic || input?.topicCluster, 100) || null;
  const rating = Number(input?.rating);
  if (!imageUrl || !source || !queryTerm || ![1, -1].includes(rating)) {
    return json({ error: 'imageUrl, source, queryTerm and a rating of 1 or -1 are required.' }, 400);
  }

  const title = normalizeText(input?.title, 400);
  const caption = normalizeText(input?.caption, 2000);
  const creator = normalizeText(input?.creator, 300);
  const collection = normalizeText(input?.collection, 240);
  const providedKeywords = Array.isArray(input?.keywords)
    ? input.keywords.map((value) => stemToken(value)).filter(Boolean).slice(0, 80)
    : [];
  const keywords = [...new Set([
    ...providedKeywords,
    ...extractSignificantTokens(`${title}. ${caption}`, new Set())
  ])].slice(0, 80);

  const existingProfile = await env.DB.prepare(`
    SELECT score FROM image_feedback_profiles WHERE image_url = ?
  `).bind(imageUrl).all();
  const currentProfile = existingProfile.results?.[0] || null;

  let startingScore = Number(currentProfile?.score || 0);
  if (!currentProfile) {
    const legacy = await env.DB.prepare(`
      SELECT COALESCE(SUM(rating), 0) AS score
      FROM image_feedback
      WHERE image_url = ?
    `).bind(imageUrl).all();
    startingScore = Number(legacy.results?.[0]?.score || 0);
  }

  await env.DB.prepare(`
    INSERT INTO image_feedback (image_url, source, query_term, topic, rating)
    VALUES (?, ?, ?, ?, ?)
  `).bind(imageUrl, source, queryTerm, topic, rating).run();

  const nextScore = startingScore + rating;
  if (currentProfile) {
    await env.DB.prepare(`
      UPDATE image_feedback_profiles
      SET source = ?, creator = ?, collection_name = ?, title = ?, caption = ?,
          keywords_json = ?, topic_cluster = ?, score = ?, updated_at = CURRENT_TIMESTAMP
      WHERE image_url = ?
    `).bind(
      source,
      creator,
      collection,
      title,
      caption,
      JSON.stringify(keywords),
      topic,
      nextScore,
      imageUrl
    ).run();
  } else {
    await env.DB.prepare(`
      INSERT INTO image_feedback_profiles (
        image_url, source, creator, collection_name, title, caption,
        keywords_json, topic_cluster, score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      imageUrl,
      source,
      creator,
      collection,
      title,
      caption,
      JSON.stringify(keywords),
      topic,
      nextScore
    ).run();
  }

  return json({ saved: true, imageUrl, rating, score: nextScore }, 201);
}

export async function ensureImageFeedbackSchema(db) {
  if (!db) throw new Error('D1 binding “DB” is not configured.');
  let promise = schemaPromises.get(db);
  if (!promise) {
    promise = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS image_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        image_url TEXT NOT NULL,
        source TEXT NOT NULL,
        query_term TEXT NOT NULL,
        topic TEXT,
        rating INTEGER NOT NULL CHECK (rating IN (-1, 1)),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS image_feedback_query_topic_idx
        ON image_feedback(query_term COLLATE NOCASE, topic COLLATE NOCASE)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS image_feedback_image_url_idx
        ON image_feedback(image_url)`),
      db.prepare(`CREATE TABLE IF NOT EXISTS image_feedback_profiles (
        image_url TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        creator TEXT,
        collection_name TEXT,
        title TEXT,
        caption TEXT,
        keywords_json TEXT,
        topic_cluster TEXT,
        score INTEGER NOT NULL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`),
      db.prepare(`CREATE INDEX IF NOT EXISTS image_feedback_profiles_score_idx
        ON image_feedback_profiles(score DESC, updated_at DESC)`),
      db.prepare(`CREATE INDEX IF NOT EXISTS image_feedback_profiles_source_idx
        ON image_feedback_profiles(source, creator)`)
    ]).catch((error) => {
      schemaPromises.delete(db);
      throw error;
    });
    schemaPromises.set(db, promise);
  }
  await promise;
}

async function loadFeedbackState(db) {
  const [profilesResponse, legacyResponse] = await Promise.all([
    db.prepare(`
      SELECT image_url, source, creator, collection_name, title, caption,
             keywords_json, topic_cluster, score
      FROM image_feedback_profiles
      WHERE score != 0
      ORDER BY updated_at DESC
      LIMIT ?
    `).bind(MAX_FEEDBACK_PROFILES).all(),
    db.prepare(`
      SELECT image_url, SUM(rating) AS score
      FROM image_feedback
      GROUP BY image_url
      HAVING SUM(rating) != 0
      LIMIT 1500
    `).all()
  ]);

  const profiles = (profilesResponse.results || []).map((row) => ({
    imageUrl: String(row.image_url || ''),
    source: normalizeText(row.source, 40).toLowerCase(),
    creator: normalizeKey(row.creator),
    collection: normalizeKey(row.collection_name),
    title: normalizeText(row.title, 400),
    caption: normalizeText(row.caption, 2000),
    keywords: new Set(parseKeywordJson(row.keywords_json)),
    cluster: stemToken(row.topic_cluster),
    score: Number(row.score || 0)
  }));
  const profileByUrl = new Map(profiles.map((profile) => [profile.imageUrl, profile]));
  const legacyScores = new Map((legacyResponse.results || []).map((row) => [
    String(row.image_url || ''), Number(row.score || 0)
  ]));

  return {
    profiles,
    profileByUrl,
    legacyScores,
    hasFeedback: profiles.length > 0 || legacyScores.size > 0
  };
}

export function rankResults(results, feedback = new Map()) {
  return results.map((result, providerRank) => ({
    ...result,
    providerRank,
    feedbackScore: Number(feedback.get(result.imageUrl) || 0)
  })).sort((a, b) =>
    b.feedbackScore - a.feedbackScore || a.providerRank - b.providerRank
  );
}

function rankWithFeedback(results, feedbackState, selectedKeyword) {
  const clusterStem = stemToken(selectedKeyword?.keyword || selectedKeyword?.label);
  return results.map((result, providerRank) => {
    const imageUrl = normalizeHttpsUrl(result.imageUrl);
    const exactProfile = feedbackState.profileByUrl.get(imageUrl);
    const exactScore = exactProfile
      ? exactProfile.score
      : Number(feedbackState.legacyScores.get(imageUrl) || 0);
    const resultKeywords = new Set(result._analysis?.keywords || []);
    const resultCreator = normalizeKey(result.creator);
    const resultCollection = normalizeKey(result.collection);

    let similarityFeedbackScore = 0;
    for (const profile of feedbackState.profiles) {
      if (!profile.score || profile.imageUrl === imageUrl) continue;
      const similarity = metadataSimilarity({
        source: result.source,
        creator: resultCreator,
        collection: resultCollection,
        keywords: resultKeywords,
        cluster: clusterStem
      }, profile);
      if (similarity < SIMILARITY_THRESHOLD) continue;
      similarityFeedbackScore += Math.sign(profile.score)
        * Math.log1p(Math.abs(profile.score))
        * similarity
        * SIMILARITY_PROPAGATION;
    }

    const exactEffect = Math.sign(exactScore) * Math.log1p(Math.abs(exactScore)) * 1.4;
    const effectiveFeedback = clamp(exactEffect + similarityFeedbackScore, -8, 8);
    const displayWeight = Math.exp(effectiveFeedback * 0.25);
    const rankingScore = effectiveFeedback - providerRank * 0.002;

    return {
      ...result,
      providerRank,
      feedbackScore: exactScore,
      similarityFeedbackScore: round(similarityFeedbackScore, 4),
      effectiveFeedbackScore: round(effectiveFeedback, 4),
      displayWeight: round(displayWeight, 4),
      rankingScore: round(rankingScore, 5)
    };
  }).sort((a, b) =>
    b.rankingScore - a.rankingScore
    || a.providerRank - b.providerRank
    || String(a.source || '').localeCompare(String(b.source || ''))
  );
}

function metadataSimilarity(result, profile) {
  const keywordScore = jaccard(result.keywords, profile.keywords);
  const sameSource = normalizeKey(result.source) && normalizeKey(result.source) === normalizeKey(profile.source) ? 1 : 0;
  const sameCreator = result.creator && profile.creator && result.creator === profile.creator ? 1 : 0;
  const sameCollection = result.collection && profile.collection && result.collection === profile.collection ? 1 : 0;
  const sameCluster = result.cluster && profile.cluster && result.cluster === profile.cluster ? 1 : 0;
  return clamp(
    keywordScore * 0.66
    + sameSource * 0.06
    + sameCreator * 0.14
    + sameCollection * 0.08
    + sameCluster * 0.06,
    0,
    1
  );
}

async function extractKeywordOptionsWithTimeout(results, query) {
  const startedAt = Date.now();
  try {
    const extraction = await extractKeywordOptions(results, query, startedAt + KEYWORD_EXTRACTION_TIMEOUT_MS);
    return {
      ...extraction,
      summary: {
        timedOut: false,
        durationMs: Date.now() - startedAt,
        minimumFrequency: MIN_KEYWORD_FREQUENCY,
        candidateCount: extraction.candidateCount,
        genericDropped: extraction.genericDropped
      }
    };
  } catch (error) {
    if (error?.name !== 'KeywordExtractionTimeoutError') throw error;
    const annotatedResults = results.map((result) => annotateResult(result, query));
    return {
      options: [],
      annotatedResults,
      candidateCount: 0,
      genericDropped: 0,
      summary: {
        timedOut: true,
        durationMs: Date.now() - startedAt,
        minimumFrequency: MIN_KEYWORD_FREQUENCY,
        candidateCount: 0,
        genericDropped: 0,
        message: 'Keyword extraction timed out; showing the broad result pool.'
      }
    };
  }
}

async function extractKeywordOptions(results, query, deadline) {
  const queryStems = new Set(tokenize(query).map(stemToken).filter(Boolean));
  const annotatedResults = [];
  const candidates = new Map();
  let sentenceNumber = 0;

  for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
    if (Date.now() > deadline) throw new KeywordExtractionTimeoutError();
    if (resultIndex && resultIndex % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    const annotated = annotateResult(results[resultIndex], query);
    annotatedResults.push(annotated);
    for (const sentence of annotated._analysis.sentences) {
      if (!containsAllStems(sentence.stems, queryStems)) continue;
      const sentenceId = `${resultIndex}:${sentenceNumber++}`;
      for (const token of sentence.tokens) {
        const stem = token.stem;
        if (!stem || queryStems.has(stem)) continue;
        let candidate = candidates.get(stem);
        if (!candidate) {
          candidate = { stem, surfaces: new Map(), sentenceIds: new Set(), resultIds: new Set() };
          candidates.set(stem, candidate);
        }
        candidate.sentenceIds.add(sentenceId);
        candidate.resultIds.add(annotated.id || annotated.imageUrl || String(resultIndex));
        candidate.surfaces.set(token.surface, Number(candidate.surfaces.get(token.surface) || 0) + 1);
      }
    }
  }

  const frequent = [...candidates.values()]
    .filter((candidate) => candidate.sentenceIds.size >= MIN_KEYWORD_FREQUENCY)
    .sort((a, b) => b.sentenceIds.size - a.sentenceIds.size)
    .slice(0, 18);
  const medianFrequency = median(frequent.map((candidate) => candidate.sentenceIds.size));
  let genericDropped = 0;

  const scored = frequent.map((candidate) => {
    const others = frequent.filter((other) => other !== candidate);
    const coverageOfOthers = weightedAverage(others.map((other) => ({
      value: intersectionSize(candidate.sentenceIds, other.sentenceIds) / Math.max(1, other.sentenceIds.size),
      weight: other.sentenceIds.size
    })));
    const sharedOwnSentences = new Set();
    for (const other of others) {
      for (const sentenceId of candidate.sentenceIds) {
        if (other.sentenceIds.has(sentenceId)) sharedOwnSentences.add(sentenceId);
      }
    }
    const selfSharedRatio = sharedOwnSentences.size / Math.max(1, candidate.sentenceIds.size);
    const genericness = coverageOfOthers - selfSharedRatio * 0.35;
    const distinctiveness = clamp(
      1 - coverageOfOthers * 0.6 + (1 - selfSharedRatio) * 0.4,
      0.05,
      1
    );
    const generic = coverageOfOthers >= 0.75
      && candidate.sentenceIds.size >= medianFrequency
      && genericness >= 0.45;
    if (generic) genericDropped += 1;
    const label = mostFrequentSurface(candidate.surfaces);
    return {
      keyword: candidate.stem,
      label: titleCase(label),
      frequency: candidate.sentenceIds.size,
      resultFrequency: candidate.resultIds.size,
      distinctiveness: round(distinctiveness, 4),
      overlapRatio: round(coverageOfOthers, 4),
      score: round(candidate.sentenceIds.size * (0.35 + distinctiveness), 4),
      generic
    };
  });

  const options = scored
    .filter((candidate) => !candidate.generic)
    .sort((a, b) =>
      b.score - a.score
      || b.frequency - a.frequency
      || a.label.localeCompare(b.label)
    )
    .slice(0, MAX_KEYWORD_OPTIONS)
    .map(({ generic, ...candidate }) => candidate);

  return {
    options,
    annotatedResults,
    candidateCount: frequent.length,
    genericDropped
  };
}

function annotateResult(result, query) {
  const title = normalizeText(result.title, 500);
  const caption = normalizeText(result.caption, 2400);
  const combined = [title, caption].filter(Boolean).join('. ');
  const sentences = splitSentences(combined).map((text) => {
    const tokens = significantTokenObjects(text, new Set());
    return { text, tokens, stems: new Set(tokenize(text).map(stemToken).filter(Boolean)) };
  });
  const keywords = [...new Set(extractSignificantTokens(combined, new Set()))].slice(0, 100);
  return {
    ...result,
    significantKeywords: keywords.slice(0, 24),
    _analysis: {
      queryStems: new Set(tokenize(query).map(stemToken).filter(Boolean)),
      sentences,
      captionStems: new Set(tokenize(caption).map(stemToken).filter(Boolean)),
      titleCaptionStems: new Set(tokenize(combined).map(stemToken).filter(Boolean)),
      keywords
    }
  };
}

function filterResultPool(fullPool, query, selectedKeyword) {
  const queryStems = new Set(tokenize(query).map(stemToken).filter(Boolean));
  const keywordStem = stemToken(selectedKeyword.keyword || selectedKeyword.label);
  const strict = fullPool.filter((result) => result._analysis.sentences.some((sentence) =>
    containsAllStems(sentence.stems, queryStems) && sentence.stems.has(keywordStem)
  ));
  if (strict.length >= MIN_STRICT_FILTER_RESULTS) {
    return { results: strict, mode: 'same-sentence', strictCount: strict.length, fallbackUsed: false };
  }

  const captionAnywhere = fullPool.filter((result) =>
    containsAllStems(result._analysis.captionStems, queryStems)
    && result._analysis.captionStems.has(keywordStem)
  );
  if (captionAnywhere.length >= MIN_STRICT_FILTER_RESULTS) {
    return {
      results: captionAnywhere,
      mode: 'same-caption',
      strictCount: strict.length,
      fallbackUsed: true
    };
  }

  const titleCaptionAnywhere = fullPool.filter((result) =>
    containsAllStems(result._analysis.titleCaptionStems, queryStems)
    && result._analysis.titleCaptionStems.has(keywordStem)
  );
  if (titleCaptionAnywhere.length) {
    return {
      results: titleCaptionAnywhere,
      mode: 'title-caption',
      strictCount: strict.length,
      fallbackUsed: true
    };
  }

  return { results: [], mode: 'no-match', strictCount: strict.length, fallbackUsed: true };
}

function resolveSelectedKeyword(selected, options) {
  if (!selected) return null;
  const stem = stemToken(selected.keyword || selected.label);
  const matched = options.find((option) => option.keyword === stem || stemToken(option.label) === stem);
  if (matched) return matched;
  return stem ? { keyword: stem, label: selected.label || titleCase(stem) } : null;
}

function normalizeSelectedKeyword(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const keyword = stemToken(value);
    return keyword ? { keyword, label: titleCase(value) } : null;
  }
  const keyword = stemToken(value.keyword || value.id || value.label);
  const label = normalizeText(value.label || value.keyword, 100);
  return keyword ? { keyword, label: label || titleCase(keyword) } : null;
}

function stripInternalAnalysis(result) {
  const { _analysis, ...publicResult } = result;
  return publicResult;
}

function splitSentences(value) {
  const text = normalizeText(value, 3000);
  if (!text) return [];
  return (text.match(/[^.!?;\n]+[.!?;]?/g) || [text])
    .map((sentence) => normalizeText(sentence, 800))
    .filter(Boolean);
}

function significantTokenObjects(value, queryStems) {
  const surfaces = tokenize(value);
  const output = [];
  const seen = new Set();
  for (const surface of surfaces) {
    const stem = stemToken(surface);
    if (!stem || queryStems.has(stem) || STOPWORDS.has(surface) || STOPWORDS.has(stem)) continue;
    if (seen.has(stem)) continue;
    seen.add(stem);
    output.push({ stem, surface });
  }
  return output;
}

function extractSignificantTokens(value, queryStems) {
  return significantTokenObjects(value, queryStems).map((token) => token.stem);
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .match(/[a-z][a-z0-9'-]{2,}/g) || [];
}

function stemToken(value) {
  let token = normalizeText(value, 80).toLowerCase().replace(/^[^a-z]+|[^a-z]+$/g, '');
  if (!token || token.length < 3 || STOPWORDS.has(token)) return '';
  token = token.replace(/'s$/, '');
  if (token.length > 6 && token.endsWith('ization')) token = `${token.slice(0, -7)}ize`;
  else if (token.length > 6 && token.endsWith('ational')) token = `${token.slice(0, -7)}ate`;
  else if (token.length > 5 && token.endsWith('ical')) token = token.slice(0, -2);
  else if (token.length > 5 && token.endsWith('ology')) token = `${token.slice(0, -1)}`;
  else if (token.length > 5 && token.endsWith('ies')) token = `${token.slice(0, -3)}y`;
  else if (token.length > 5 && token.endsWith('ing')) token = token.slice(0, -3);
  else if (token.length > 4 && token.endsWith('ed')) token = token.slice(0, -2);
  else if (token.length > 5 && token.endsWith('es')) token = token.slice(0, -2);
  else if (token.length > 4 && token.endsWith('s')) token = token.slice(0, -1);
  if (token.length > 5 && token.endsWith('al')) token = token.slice(0, -2);
  if (token.length > 5 && token.endsWith('ic')) token = token.slice(0, -2);
  return token.length >= 3 && !STOPWORDS.has(token) ? token : '';
}

function containsAllStems(haystack, needles) {
  if (!needles.size) return true;
  for (const needle of needles) if (!haystack.has(needle)) return false;
  return true;
}

function parseKeywordJson(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed.map(stemToken).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function jaccard(a, b) {
  if (!a?.size || !b?.size) return 0;
  const intersection = intersectionSize(a, b);
  const union = a.size + b.size - intersection;
  return union ? intersection / union : 0;
}

function intersectionSize(a, b) {
  let count = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const value of small) if (large.has(value)) count += 1;
  return count;
}

function weightedAverage(items) {
  const totalWeight = items.reduce((total, item) => total + Number(item.weight || 0), 0);
  if (!totalWeight) return 0;
  return items.reduce((total, item) => total + item.value * item.weight, 0) / totalWeight;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function mostFrequentSurface(surfaces) {
  return [...surfaces.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || '';
}

function titleCase(value) {
  const text = normalizeText(value, 100).replace(/[-_]+/g, ' ');
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

function summarizeProviderState(sourceStatus) {
  const available = sourceStatus.filter((item) => item.ok).map((item) => item.source);
  const skipped = sourceStatus.filter((item) => item.skipped).map((item) => item.source);
  return { available, skipped, partial: skipped.length > 0 };
}

async function buildPoolCacheKey(query) {
  const bytes = new TextEncoder().encode(`${CACHE_VERSION}\n${normalizeKey(query)}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hash = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `adaptive-image-pools/${CACHE_VERSION}/${hash}.json`;
}

async function readPoolCache(bucket, key) {
  try {
    const object = await bucket.get(key);
    if (!object) return null;
    const payload = JSON.parse(await object.text());
    if (!payload?.expiresAt || payload.expiresAt <= Date.now() || !Array.isArray(payload.results)) {
      await bucket.delete(key).catch(() => {});
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

async function writePoolCache(bucket, key, payload, ttlSeconds) {
  try {
    const cachedAt = Date.now();
    const expiresAt = cachedAt + ttlSeconds * 1000;
    await bucket.put(key, JSON.stringify({ ...payload, cachedAt, expiresAt }), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: { expiresAt: String(expiresAt), kind: 'adaptive-image-result-pool' }
    });
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'adaptive_image_pool_cache_write_failed',
      message: error instanceof Error ? error.message : String(error)
    }));
  }
}

function cacheTtlSeconds(env) {
  const value = Number(env.IMAGE_SEARCH_CACHE_TTL_SECONDS || DEFAULT_CACHE_TTL_SECONDS);
  if (!Number.isFinite(value)) return DEFAULT_CACHE_TTL_SECONDS;
  return Math.max(300, Math.min(value, 30 * 24 * 60 * 60));
}

function normalizeText(value, maxLength = 1000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizeKey(value) {
  return normalizeText(value, 500).toLowerCase();
}

function normalizeHttpsUrl(value) {
  try {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function assertSameOrigin(request, url) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) {
    throw new HttpError(403, 'Cross-origin image-search requests are not allowed.');
  }
}

async function readJson(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    throw new HttpError(415, 'The request body must be JSON.');
  }
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'The JSON request body is invalid.');
  }
}

function methodNotAllowed(allow) {
  return json({ error: `Method not allowed. Use ${allow}.` }, 405, { Allow: allow });
}

function json(payload, status = 200, extraHeaders = {}) {
  return Response.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders
    }
  });
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(Number(value || 0) * factor) / factor;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class KeywordExtractionTimeoutError extends Error {
  constructor() {
    super('Keyword extraction timed out.');
    this.name = 'KeywordExtractionTimeoutError';
  }
}

export { imageSearchErrorResponse };
