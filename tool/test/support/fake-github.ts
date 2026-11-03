// ABOUTME: In-memory GitHub for flow tests: default-branch files, queue comments, PRs and fork releases.
// ABOUTME: Release assets are written to a temp dir and served by `fetch` at https://assets.fake.test/... URLs.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { ClaimComment, ContributionPr } from '../../src/claim';
import type { GitHub, RepoFile } from '../../src/github';

export interface FakePr extends ContributionPr {
  branch: string;
  files: RepoFile[];
  title: string;
  body: string;
}

export class FakeGitHub implements GitHub {
  user = 'alice';
  files = new Map<string, string>();
  comments: ClaimComment[] = [];
  prs: FakePr[] = [];
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
    this.prs.push({ number, author: this.user, createdAt: new Date(this.clock()).toISOString(), state: 'open', ci: 'pending', branch, files, title, body });
    return { number, url: `https://github.com/${repo}/pull/${number}` };
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
