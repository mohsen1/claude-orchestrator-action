#!/usr/bin/env node
/**
 * Director executable entry point
 * Called by GitHub Actions workflow
 */

import { Director } from './index.js';
import type { ClaudeConfig } from '../shared/config.js';

async function main() {
  // Parse environment variables
  const token = process.env.GITHUB_TOKEN || process.env.CCO_PAT;
  if (!token) {
    throw new Error('GITHUB_TOKEN or CCO_PAT is required');
  }

  const repoOwner = process.env.REPO_OWNER;
  const repoName = process.env.REPO_NAME;
  if (!repoOwner || !repoName) {
    throw new Error('REPO_OWNER and REPO_NAME are required');
  }

  const issueNumber = parseInt(process.env.ISSUE_NUMBER || '0', 10);
  if (!issueNumber) {
    throw new Error('ISSUE_NUMBER is required');
  }

  const issueTitle = process.env.ISSUE_TITLE || '';
  const issueBody = process.env.ISSUE_BODY || '';

  const resume = process.env.RESUME === 'true';

  // Parse Claude configs
  const configsJson = process.env.CLAUDE_CONFIGS || '[]';
  const configs: ClaudeConfig[] = JSON.parse(configsJson);

  // Parse options
  const maxEms = parseInt(process.env.MAX_EMS || '5', 10);
  const maxWorkersPerEm = parseInt(process.env.MAX_WORKERS_PER_EM || '4', 10);
  const dispatchStaggerMs = parseInt(process.env.DISPATCH_STAGGER_MS || '2000', 10);

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
