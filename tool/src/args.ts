// ABOUTME: Shared argument parsing for the contributor and coordinator command lines (strict util.parseArgs).
// ABOUTME: Each command declares its options and positional count; --repo is accepted by every command.

import { parseArgs } from 'node:util';

export class UsageError extends Error {}

export interface ParsedCommand {
  command: string;
  repo: string;
  flags: Record<string, string | boolean | undefined>;
  positionals: string[];
}

export interface CommandSpec {
  options: Record<string, { type: 'boolean' | 'string' }>;
  positionals?: number;
}

export function parseCommandLine(argv: string[], commands: Record<string, CommandSpec>, defaultRepo: string): ParsedCommand {
  const [command, ...rest] = argv;
  if (!command || !(command in commands)) throw new UsageError(command ? `unknown command: ${command}` : 'no command given');
  const spec = commands[command];
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { ...spec.options, repo: { type: 'string' } }, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const want = spec.positionals ?? 0;
  if (parsed.positionals.length !== want) throw new UsageError(`${command} takes ${want} argument(s), got ${parsed.positionals.length}`);
  const repo = (parsed.values.repo as string | undefined) ?? defaultRepo;
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new UsageError(`--repo must be <owner>/<name>, got ${repo}`);
  return { command, repo, flags: parsed.values as ParsedCommand['flags'], positionals: parsed.positionals };
}
