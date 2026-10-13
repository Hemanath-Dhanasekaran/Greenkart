'use strict';

const { execFileSync } = require('child_process');

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function createGit(cwd) {
  const run = (args, opts = {}) => execFileSync('git', args, {
    cwd,
    encoding: opts.buffer ? 'buffer' : 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', opts.quiet ? 'ignore' : 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const tryRun = (args, opts) => {
    try {
      return run(args, { ...opts, quiet: true });
    } catch {
      return null;
    }
  };

  return {
    cwd,
    run,
    tryRun,

    /** Commits reachable from `ref`, oldest first, parents before children. */
    revList(ref, { exclude = [], max } = {}) {
      const args = ['rev-list', '--reverse', '--topo-order'];
      if (max) args.push(`--max-count=${max}`);
      args.push(ref, ...exclude.map((e) => `^${e}`));
      const out = tryRun(args);
      return out ? out.split('\n').filter(Boolean) : [];
    },

    commitMeta(sha) {
      const out = run(['show', '-s', '--format=%H%x00%P%x00%an%x00%aI%x00%cn%x00%cI%x00%s', sha]).replace(/\n$/, '');
      const [full, parents, authorName, authoredAt, committerName, committedAt, subject] = out.split('\0');
      return { sha: full, parents: parents ? parents.split(' ') : [], authorName, authoredAt, committerName, committedAt, subject };
    },

    /** Changed files of a commit against its first parent (renames detected). */
    nameStatus(sha, parent) {
      const args = ['diff-tree', '-r', '-M50%', '--name-status', '--no-commit-id', '-z', parent || EMPTY_TREE, sha];
      const parts = run(args).split('\0').filter((p) => p !== '');
      const out = [];
      for (let i = 0; i < parts.length;) {
        const status = parts[i++];
        const code = status[0];
        if (code === 'R' || code === 'C') {
          out.push({ status: code === 'R' ? 'renamed' : 'copied', similarity: Number(status.slice(1)) || null, oldPath: parts[i++], path: parts[i++] });
        } else {
          out.push({ status: { A: 'added', M: 'modified', D: 'deleted', T: 'modified' }[code] || 'modified', path: parts[i++] });
        }
      }
      return out;
    },

    /** path -> blob sha for every file in a commit's tree. */
    lsTree(sha) {
      const out = run(['ls-tree', '-r', '-z', sha]);
      const files = {};
      for (const entry of out.split('\0').filter(Boolean)) {
        const tab = entry.indexOf('\t');
        const [, type, blob] = entry.slice(0, tab).split(' ');
        if (type === 'blob') files[entry.slice(tab + 1)] = blob;
      }
      return files;
    },

    blob(blobSha) {
      return run(['cat-file', 'blob', blobSha], { buffer: true });
    },

    hasObject(sha) {
      return tryRun(['cat-file', '-e', `${sha}^{commit}`]) !== null;
    },

    isShallow() {
      return (tryRun(['rev-parse', '--is-shallow-repository']) || '').trim() === 'true';
    },

    resolve(ref) {
      const out = tryRun(['rev-parse', '--verify', `${ref}^{commit}`]);
      return out ? out.trim() : null;
    },

    currentBranch() {
      return (tryRun(['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim() || null;
    },

    remoteUrl(remote = 'origin') {
      return (tryRun(['remote', 'get-url', remote]) || '').trim() || null;
    },
  };
}

/** "owner/repo" from an https or ssh GitHub remote URL. */
function repoSlugFromUrl(url) {
  if (!url) return null;
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

module.exports = { createGit, repoSlugFromUrl, EMPTY_TREE };
