'use strict';

const { execFile } = require('child_process');
const path = require('path');

const MAX_BUFFER = 1024 * 1024 * 20; // 20MB, generous headroom above the 5MB file-size cap

/**
 * @typedef {{ isRepo: boolean, repoRoot: string|null, tracked: boolean, hasHead: boolean, relativePath?: string }} FileGitState
 */

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stderr }));
        return;
      }
      resolve(stdout);
    });
  });
}

async function isInsideWorkTree(dirPath) {
  try {
    const out = await run('git', ['rev-parse', '--is-inside-work-tree'], dirPath);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

async function getRepoRoot(dirPath) {
  try {
    const out = await run('git', ['rev-parse', '--show-toplevel'], dirPath);
    return out.trim();
  } catch {
    return null;
  }
}

async function hasHeadCommit(repoRoot) {
  try {
    await run('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], repoRoot);
    return true;
  } catch {
    // Newly initialized repo with zero commits: `HEAD` doesn't resolve yet.
    return false;
  }
}

async function isTracked(repoRoot, relativePath) {
  try {
    const out = await run('git', ['ls-files', '--error-unmatch', '--', relativePath], repoRoot);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Determines whether a file lives inside a Git working tree, whether that
 * repo has any commits yet, and whether the file itself is tracked. All of
 * added-file / untracked / no-commits-yet edge cases resolve to
 * `tracked: false` so callers can uniformly skip diffing.
 * @param {string} filePath
 * @returns {Promise<FileGitState>}
 */
async function getFileGitStatus(filePath) {
  const dir = path.dirname(filePath);
  const insideRepo = await isInsideWorkTree(dir);
  if (!insideRepo) {
    return { isRepo: false, repoRoot: null, tracked: false, hasHead: false };
  }

  const repoRoot = await getRepoRoot(dir);
  if (!repoRoot) {
    return { isRepo: true, repoRoot: null, tracked: false, hasHead: false };
  }

  const hasHead = await hasHeadCommit(repoRoot);
  if (!hasHead) {
    return { isRepo: true, repoRoot, tracked: false, hasHead: false };
  }

  const relativePath = path.relative(repoRoot, filePath).split(path.sep).join('/');
  const tracked = await isTracked(repoRoot, relativePath);
  return { isRepo: true, repoRoot, tracked, hasHead: true, relativePath };
}

/**
 * Fetches the file's content as of HEAD via `git show`. Returns `null` for
 * any case where a HEAD version doesn't exist (new/untracked file, no
 * commits yet) rather than throwing, since that's an expected state.
 * @param {string} repoRoot
 * @param {string} relativePath already-forward-slashed, relative to repoRoot
 * @returns {Promise<string|null>}
 */
async function getHeadFileContent(repoRoot, relativePath) {
  try {
    return await run('git', ['show', `HEAD:${relativePath}`], repoRoot);
  } catch {
    return null;
  }
}

module.exports = { getFileGitStatus, getHeadFileContent };
