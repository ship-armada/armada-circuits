// ABOUTME: In-memory GitHub for flow tests: default-branch files, queue comments, PRs and fork releases.
// ABOUTME: Release assets are written to a temp dir and served by `fetch` at https://assets.fake.test/... URLs.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ClaimComment, ContributionPr } from '../../src/claim';
import type { MaintainerGitHub, PullRequestInfo, RepoFile, WorkflowRun } from '../../src/github';

export interface FakePr extends ContributionPr {
  branch: string;
  files: RepoFile[];
  title: string;
  body: string;
  /** Head commit; changes when the PR is updated. */
  headSha: string;
}

export class FakeGitHub implements MaintainerGitHub {
  user = 'alice';
  files = new Map<string, string>();
  comments: ClaimComment[] = [];
  prs: FakePr[] = [];
  /** Workflow runs by head commit, as the Actions API would report them. */
  runs: WorkflowRun[] = [];
  merged: { number: number; headSha: string }[] = [];
  /** Called right after a comment is posted (e.g. to simulate a competing claim). */
  afterPost?: (id: number) => void;
  /** Called on every default-branch read; may return replacement content. */
  onRead?: (filePath: string, count: number) => string | undefined;
  /** Default-branch reads so far; tests reset it between cases. */
  reads = 0;
  private nextId = 1000;
  readonly baseUrl = 'https://assets.fake.test';

  constructor(readonly repo: string, readonly assetDir: string, private readonly clock: () => number) {}

  /** A fetch that serves hosted assets, for DownloadOptions.fetch. */
  readonly fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const file = path.join(this.assetDir, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (url.origin !== this.baseUrl || !file.startsWith(this.assetDir) || !fs.existsSync(file)) return new Response('not found', { status: 404 });
    return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { status: 200 });
  }) as typeof fetch;

  /** Host a file and return its URL (used for the official release and base zkeys). */
  host(relPath: string, source: string): string {
    const dest = path.join(this.assetDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(source, dest);
    return `${this.baseUrl}/${relPath}`;
  }

  async whoami(): Promise<string> {
    return this.user;
  }

  async readDefaultBranchFile(repo: string, filePath: string): Promise<string> {
    this.assertRepo(repo);
    this.reads += 1;
    const replaced = this.onRead?.(filePath, this.reads);
    if (replaced !== undefined) return replaced;
    const v = this.files.get(filePath);
    if (v === undefined) throw new Error(`404 ${filePath}`);
    return v;
  }

  async listIssueComments(repo: string): Promise<ClaimComment[]> {
    this.assertRepo(repo);
    return this.comments.map((c) => ({ ...c }));
  }

  async postIssueComment(repo: string, _issue: number, body: string): Promise<number> {
    this.assertRepo(repo);
    const id = this.nextId++;
    this.comments.push({ id, author: this.user, body, createdAt: new Date(this.clock()).toISOString() });
    this.afterPost?.(id);
    return id;
  }

  async deleteIssueComment(repo: string, commentId: number): Promise<void> {
    this.assertRepo(repo);
    this.comments = this.comments.filter((c) => c.id !== commentId);
  }

  async listContributionPrs(repo: string): Promise<ContributionPr[]> {
    this.assertRepo(repo);
    return this.prs.map(({ number, author, createdAt, state, ci }) => ({ number, author, createdAt, state, ci }));
  }

  async uploadToForkRelease(repo: string, tag: string, files: string[]): Promise<Record<string, string>> {
    this.assertRepo(repo);
    const out: Record<string, string> = {};
    for (const f of files) out[path.basename(f)] = this.host(`${this.user}/releases/download/${tag}/${path.basename(f)}`, f);
    return out;
  }

  async openPullRequest(repo: string, branch: string, files: RepoFile[], title: string, body: string): Promise<{ number: number; url: string }> {
    this.assertRepo(repo);
    const number = this.nextId++;
    this.prs.push({ number, author: this.user, createdAt: new Date(this.clock()).toISOString(), state: 'open', ci: 'pending', branch, files, title, body, headSha: `sha-${number}` });
    return { number, url: `https://github.com/${repo}/pull/${number}` };
  }

  /** Record a completed run of the contribution check for a PR's current head. */
  passCheck(number: number, over: Partial<WorkflowRun> = {}): void {
    const pr = this.pr(number);
    pr.ci = over.conclusion === 'failure' ? 'failure' : 'success';
    this.runs.push({ path: '.github/workflows/contribution-check.yml', event: 'pull_request_target', status: 'completed', conclusion: 'success', headSha: pr.headSha, ...over });
  }

  private pr(number: number): FakePr {
    const pr = this.prs.find((p) => p.number === number);
    if (!pr) throw new Error(`no PR ${number}`);
    return pr;
  }

  async getPullRequest(repo: string, number: number): Promise<PullRequestInfo> {
    this.assertRepo(repo);
    const p = this.pr(number);
    return { number, author: p.author, state: p.state, headRef: p.branch, headSha: p.headSha, headRepo: `${p.author}/fork` };
  }

  async listPullRequestFiles(repo: string, number: number): Promise<string[]> {
    this.assertRepo(repo);
    return this.pr(number).files.map((f) => f.path);
  }

  async readFileAtRef(repo: string, filePath: string, ref: string): Promise<string> {
    const p = this.prs.find((x) => x.headSha === ref && `${x.author}/fork` === repo);
    const f = p?.files.find((x) => x.path === filePath);
    if (!f) throw new Error(`404 ${repo}:${filePath}@${ref}`);
    return f.content;
  }

  async listWorkflowRuns(repo: string, headSha: string): Promise<WorkflowRun[]> {
    this.assertRepo(repo);
    return this.runs.filter((r) => r.headSha === headSha);
  }

  async uploadToRelease(repo: string, tag: string, files: string[]): Promise<Record<string, string>> {
    this.assertRepo(repo);
    const out: Record<string, string> = {};
    for (const f of files) out[path.basename(f)] = this.host(`${repo}/releases/download/${tag}/${path.basename(f)}`, f);
    return out;
  }

  async mergePullRequest(repo: string, number: number, headSha: string): Promise<void> {
    this.assertRepo(repo);
    const p = this.pr(number);
    if (p.headSha !== headSha) throw new Error(`head of PR ${number} is ${p.headSha}, not ${headSha}`);
    if (p.state !== 'open') throw new Error(`PR ${number} is ${p.state}`);
    this.merge(number);
    this.merged.push({ number, headSha });
  }

  /** Accept a PR: apply its files to the default branch. */
  merge(number: number): void {
    const pr = this.prs.find((p) => p.number === number);
    if (!pr) throw new Error(`no PR ${number}`);
    for (const f of pr.files) this.files.set(f.path, f.content);
    pr.state = 'merged';
    pr.ci = 'success';
  }

  private assertRepo(repo: string): void {
    if (repo !== this.repo) throw new Error(`unexpected repo ${repo}`);
  }
}
