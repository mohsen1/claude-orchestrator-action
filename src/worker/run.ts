#!/usr/bin/env node
/**
 * Worker executable entry point
 * Called by GitHub Actions workflow
 */

import { Worker } from './index.js';
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

  const emId = parseInt(process.env.EM_ID || '0', 10);
  if (!emId) {
    throw new Error('EM_ID is required');
  }

  const workerId = parseInt(process.env.WORKER_ID || '0', 10);
  if (!workerId) {
    throw new Error('WORKER_ID is required');
  }

  const taskAssignment = process.env.TASK_ASSIGNMENT || '';
  const emBranch = process.env.EM_BRANCH || '';

  const resume = process.env.RESUME === 'true';
  const sessionId = process.env.SESSION_ID;

  // Parse Claude configs
  const configsJson = process.env.CLAUDE_CONFIGS || '[]';
  const configs: ClaudeConfig[] = JSON.parse(configsJson);

  // Parse options
  const maxRetries = parseInt(process.env.MAX_RETRIES || '2', 10);

  // Build context
  const context = {
    repo: {
      owner: repoOwner,
      repo: repoName
    },
    token,
    issue: {
      number: issueNumber
    },
    emId,
    workerId,
    taskAssignment,
    emBranch,
    configs,
    resume,
    sessionId,
    options: {
      maxRetries
    }
  };

  // Create and run Worker
  const worker = new Worker(context);

  if (resume) {
    if (!sessionId) {
      throw new Error('SESSION_ID is required when resuming');
    }
    const feedback = taskAssignment;
    await worker.resume(sessionId, feedback);
  } else {
    await worker.run();
  }
}

main().catch(error => {
  console.error('Worker failed:', error);
  process.exit(1);
});
