#!/usr/bin/env node
/**
 * Review Handler executable entry point
 * Called by GitHub Actions workflow
 */

import { ReviewHandler } from './index.js';

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

  const prNumber = parseInt(process.env.PR_NUMBER || '0', 10);
  if (!prNumber) {
    throw new Error('PR_NUMBER is required');
  }

  const headRef = process.env.PR_HEAD_REF || '';
  const baseRef = process.env.PR_BASE_REF || '';
  const prBody = process.env.PR_BODY || '';

  const reviewState = process.env.REVIEW_STATE || 'commented';
  const reviewBody = process.env.REVIEW_BODY || '';

  const configs = process.env.CLAUDE_CONFIGS || '[]';

  // Build context
  const context = {
    repo: {
      owner: repoOwner,
      repo: repoName
    },
    token,
    pr: {
      number: prNumber,
      headRef,
      baseRef,
      body: prBody
    },
    review: {
      state: reviewState as any,
      body: reviewBody
    },
    configs
  };

  // Create and run Review Handler
  const handler = new ReviewHandler(context);
  await handler.handleReview();
}

main().catch(error => {
  console.error('Review Handler failed:', error);
  process.exit(1);
});
