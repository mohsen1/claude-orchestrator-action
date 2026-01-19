#!/usr/bin/env node
/**
 * Director executable entry point
 * Called by GitHub Actions workflow
 */

import { Director } from './index.js';
import type { ClaudeConfig } from '../shared/config.js';

async function main() {
  // Parse environment variables
  // GitHub Actions prefixes inputs with INPUT_, so we check both formats
  const getInput = (name: string): string | undefined => {
    return process.env[`INPUT_${name}`] || process.env[name];
  };

  const token = getInput('github-token') || process.env.GITHUB_TOKEN || process.env.CCO_PAT;
  if (!token) {
    throw new Error('github-token input is required');
  }

  const repoOwner = getInput('repo-owner') || process.env.REPO_OWNER;
  const repoName = getInput('repo-name') || process.env.REPO_NAME;
  if (!repoOwner || !repoName) {
    throw new Error('repo-owner and repo-name inputs are required');
  }

  const issueNumber = parseInt(getInput('issue-number') || process.env.ISSUE_NUMBER || '0', 10);
  if (!issueNumber) {
    throw new Error('issue-number input is required');
  }

  const issueTitle = getInput('issue-title') || process.env.ISSUE_TITLE || '';
  const issueBody = getInput('issue-body') || process.env.ISSUE_BODY || '';

  const resume = process.env.RESUME === 'true';

  // Parse Claude configs
  const configsJson = getInput('claude-configs') || process.env.CLAUDE_CONFIGS || '[]';
  const configs: ClaudeConfig[] = JSON.parse(configsJson);

  // Parse options
  const maxEms = parseInt(getInput('max-ems') || process.env.MAX_EMS || '5', 10);
  const maxWorkersPerEm = parseInt(getInput('max-workers-per-em') || process.env.MAX_WORKERS_PER_EM || '4', 10);
  const dispatchStaggerMs = parseInt(getInput('dispatch-stagger-ms') || process.env.DISPATCH_STAGGER_MS || '2000', 10);

  // Build context
  const context = {
    repo: {
      owner: repoOwner,
      repo: repoName
    },
    token,
    issue: {
      number: issueNumber,
      title: issueTitle,
      body: issueBody
    },
    configs,
    options: {
      maxEms,
      maxWorkersPerEm,
      dispatchStaggerMs
    }
  };

  // Create and run Director
  const director = new Director(context);

  if (resume) {
    const sessionId = process.env.SESSION_ID;
    if (!sessionId) {
      throw new Error('SESSION_ID is required when resuming');
    }
    await director.resume(sessionId);
  } else {
    await director.run();
  }
}

main().catch(error => {
  console.error('Director failed:', error);
  process.exit(1);
});
