#!/usr/bin/env node
/**
 * E2E orchestrator entry point
 * Runs the full Director -> EM -> Worker hierarchy in one workflow
 */

import { E2EOrchestrator } from './index.js';
import type { ClaudeConfig } from '../shared/config.js';

async function main() {
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

  if (!issueTitle) {
    throw new Error('ISSUE_TITLE is required');
  }

  const configsJson = process.env.CLAUDE_CONFIGS || '[]';
  let configs: ClaudeConfig[];
  try {
    configs = JSON.parse(configsJson);
  } catch (e) {
    throw new Error(`Failed to parse CLAUDE_CONFIGS: ${(e as Error).message}`);
  }

  if (!Array.isArray(configs) || configs.length === 0) {
    throw new Error('CLAUDE_CONFIGS must be a non-empty JSON array');
  }

  const maxEms = parseInt(process.env.MAX_EMS || '3', 10);
  const maxWorkersPerEm = parseInt(process.env.MAX_WORKERS_PER_EM || '3', 10);

  console.log('E2E Orchestrator starting...');
  console.log(`  Repo: ${repoOwner}/${repoName}`);
  console.log(`  Issue: #${issueNumber} - ${issueTitle}`);
  console.log(`  Max EMs: ${maxEms}, Max Workers per EM: ${maxWorkersPerEm}`);

  const orchestrator = new E2EOrchestrator({
    repo: { owner: repoOwner, repo: repoName },
    token,
    issue: {
      number: issueNumber,
      title: issueTitle,
      body: issueBody
    },
    configs,
    options: {
      maxEms,
      maxWorkersPerEm
    }
  });

  await orchestrator.run();
}

main().catch(error => {
  console.error('E2E Orchestration failed:', error);
  process.exit(1);
});
