// ABOUTME: GitHub access for the ceremony tooling, behind one interface so flows can be tested with a fake.
// ABOUTME: GhCli implements it with the `gh` CLI (gh api), using the contributor's own gh login.

import { execFile } from 'node:child_process';
import path from 'node:path';
import type { ClaimComment, ContributionPr } from './claim';

/** Head-branch prefix that marks a PR as a ceremony contribution. */
export const CONTRIBUTION_BRANCH_PREFIX = 'ceremony/turn-';
/** Name of the read-only contribution check (M3 workflow job). */
export const CONTRIBUTION_CHECK_NAME = 'contribution-check';

export interface RepoFile {
  /** Repo-relative path. */
  path: string;
  content: string;
}

export interface GitHub {
  /** Login of the authenticated user. */
  whoami(): Promise<string>;
  /** A file's contents on the repo's default branch. */
  readDefaultBranchFile(repo: string, filePath: string): Promise<string>;
  listIssueComments(repo: string, issue: number): Promise<ClaimComment[]>;
  postIssueComment(repo: string, issue: number, body: string): Promise<number>;
  deleteIssueComment(repo: string, commentId: number): Promise<void>;
  /** Open contribution PRs plus recently created ones (enough for the claim rules). */
  listContributionPrs(repo: string): Promise<ContributionPr[]>;
  /** Upload files to a release on the user's fork of `repo`; returns each file's download URL by basename. */
  uploadToForkRelease(repo: string, tag: string, files: string[], notes: string): Promise<Record<string, string>>;
  /** Commit `files` on top of `repo`'s default branch in a fork branch and open a PR to `repo`. */
  openPullRequest(repo: string, branch: string, files: RepoFile[], title: string, body: string): Promise<{ number: number; url: string }>;
}

export type GhRunner = (args: string[], input?: string) => Promise<string>;

const defaultRunner: GhRunner = (args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile('gh', args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${stderr.trim() || err.message}`));
      else resolve(stdout);
    });
    if (input !== undefined) child.stdin?.end(input);
  });

interface ApiComment { id: number; user: { login: string }; body: string; created_at: string }
interface ApiPull { number: number; user: { login: string }; created_at: string; state: string; merged_at: string | null; head: { ref: string; sha: string } }
interface ApiCheckRun { status: string; conclusion: string | null }

/** GitHub access through the `gh` CLI. `run` is injectable for tests. */
export class GhCli implements GitHub {
  private login?: string;

  constructor(private readonly run: GhRunner = defaultRunner) {}

  private async api<T>(args: string[], input?: unknown): Promise<T> {
    const out = await this.run(['api', ...args, ...(input === undefined ? [] : ['--input', '-'])], input === undefined ? undefined : JSON.stringify(input));
    return (out.trim() === '' ? undefined : JSON.parse(out)) as T;
  }

  async whoami(): Promise<string> {
    if (!this.login) this.login = (await this.api<{ login: string }>(['user'])).login;
    return this.login;
  }

  async readDefaultBranchFile(repo: string, filePath: string): Promise<string> {
    return this.run(['api', `repos/${repo}/contents/${filePath}`, '-H', 'Accept: application/vnd.github.raw']);
  }

  async listIssueComments(repo: string, issue: number): Promise<ClaimComment[]> {
    const pages = await this.api<ApiComment[][]>(['--paginate', '--slurp', `repos/${repo}/issues/${issue}/comments?per_page=100`]);
    return pages.flat().map((c) => ({ id: c.id, author: c.user.login, body: c.body, createdAt: c.created_at }));
  }

  async postIssueComment(repo: string, issue: number, body: string): Promise<number> {
    return (await this.api<{ id: number }>([`repos/${repo}/issues/${issue}/comments`], { body })).id;
  }

  async deleteIssueComment(repo: string, commentId: number): Promise<void> {
    await this.run(['api', '-X', 'DELETE', `repos/${repo}/issues/comments/${commentId}`]);
  }

  async listContributionPrs(repo: string): Promise<ContributionPr[]> {
    const pulls = await this.api<ApiPull[]>([`repos/${repo}/pulls?state=all&sort=created&direction=desc&per_page=100`]);
    const ours = pulls.filter((p) => p.head.ref.startsWith(CONTRIBUTION_BRANCH_PREFIX));
    const out: ContributionPr[] = [];
    for (const p of ours) {
      const state: ContributionPr['state'] = p.state === 'open' ? 'open' : p.merged_at ? 'merged' : 'closed';
      let ci: ContributionPr['ci'] = 'pending';
      if (state === 'open') {
        const runs = await this.api<{ check_runs: ApiCheckRun[] }>([`repos/${repo}/commits/${p.head.sha}/check-runs?check_name=${CONTRIBUTION_CHECK_NAME}`]);
        const latest = runs.check_runs[0];
        if (latest && latest.status === 'completed') ci = latest.conclusion === 'success' ? 'success' : 'failure';
      }
      out.push({ number: p.number, author: p.user.login, createdAt: p.created_at, state, ci });
    }
    return out;
  }

  /** The user's fork of `repo`, created if missing. */
  private async fork(repo: string): Promise<{ fullName: string; owner: string }> {
    const me = await this.whoami();
    const find = async () => (await this.api<{ full_name: string; owner: { login: string } }[][]>(['--paginate', '--slurp', `repos/${repo}/forks?per_page=100`]))
      .flat().find((f) => f.owner.login === me);
    let f = await find();
    if (!f) {
      await this.run(['repo', 'fork', repo, '--clone=false', '--default-branch-only']);
      f = await find();
    }
    if (!f) throw new Error(`could not find or create ${me}'s fork of ${repo}`);
    return { fullName: f.full_name, owner: me };
  }

  async uploadToForkRelease(repo: string, tag: string, files: string[], notes: string): Promise<Record<string, string>> {
    const { fullName } = await this.fork(repo);
    const exists = await this.run(['release', 'view', tag, '--repo', fullName, '--json', 'tagName']).then(() => true, () => false);
    if (exists) await this.run(['release', 'upload', tag, ...files, '--repo', fullName, '--clobber']);
    else await this.run(['release', 'create', tag, ...files, '--repo', fullName, '--title', tag, '--notes', notes]);
    return Object.fromEntries(files.map((f) => [path.basename(f), `https://github.com/${fullName}/releases/download/${tag}/${path.basename(f)}`]));
  }

  async openPullRequest(repo: string, branch: string, files: RepoFile[], title: string, body: string): Promise<{ number: number; url: string }> {
    const { fullName, owner } = await this.fork(repo);
    const base = (await this.api<{ default_branch: string }>([`repos/${repo}`])).default_branch;
    const baseSha = (await this.api<{ object: { sha: string } }>([`repos/${repo}/git/ref/heads/${base}`])).object.sha;
    const baseTree = (await this.api<{ tree: { sha: string } }>([`repos/${repo}/git/commits/${baseSha}`])).tree.sha;
    // Forks share git objects with their parent, so the upstream commit and tree can be used directly.
    const tree = await this.api<{ sha: string }>([`repos/${fullName}/git/trees`], {
      base_tree: baseTree,
      tree: files.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
    });
    const commit = await this.api<{ sha: string }>([`repos/${fullName}/git/commits`], { message: title, tree: tree.sha, parents: [baseSha] });
    const ref = `refs/heads/${branch}`;
    const hasRef = await this.run(['api', `repos/${fullName}/git/ref/heads/${branch}`]).then(() => true, () => false);
    if (hasRef) await this.api([`repos/${fullName}/git/${ref}`, '-X', 'PATCH'], { sha: commit.sha, force: true });
    else await this.api([`repos/${fullName}/git/refs`], { ref, sha: commit.sha });
    const pr = await this.api<{ number: number; html_url: string }>([`repos/${repo}/pulls`], { title, body, head: `${owner}:${branch}`, base });
    return { number: pr.number, url: pr.html_url };
  }
}
