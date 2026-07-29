import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = resolve(root, 'worker/src/deployment-meta.generated.js');
const FIX_COMMIT_SHA = '1a1ef610e1326e2f110f1956655066ff383c6a9e';

function validSha(value) {
  return typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value.trim()) ? value.trim().toLowerCase() : '';
}

function resolveCommitSha() {
  for (const value of [
    process.env.CF_PAGES_COMMIT_SHA,
    process.env.GITHUB_SHA,
    process.env.COMMIT_SHA
  ]) {
    const sha = validSha(value);
    if (sha) return sha;
  }
  try {
    return validSha(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })) || 'unknown';
  } catch {
    return 'unknown';
  }
}

const deploymentCommitSha = resolveCommitSha();
const generatedAt = new Date().toISOString();
await writeFile(outputPath, [
  `export const DEPLOYMENT_COMMIT_SHA = ${JSON.stringify(deploymentCommitSha)};`,
  `export const FIX_COMMIT_SHA = ${JSON.stringify(FIX_COMMIT_SHA)};`,
  `export const DEPLOYMENT_METADATA_GENERATED_AT = ${JSON.stringify(generatedAt)};`,
  ''
].join('\n'), 'utf8');

console.log(`Generated deployment metadata for ${deploymentCommitSha}.`);
