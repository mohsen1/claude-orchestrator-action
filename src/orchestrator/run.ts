#!/usr/bin/env node
/**
 * Event-driven orchestrator entry point
 * 
 * Called by GitHub workflows on various events.
 * Reads event type and payload from environment, dispatches to orchestrator.
 */

import { EventDrivenOrchestrator, EventType, OrchestratorEvent } from './index.js';
import type { ClaudeConfig } from '../shared/config.js';

async function main() {
  // Get required environment variables
  const token = process.env.GITHUB_TOKEN || process.env.CCO_PAT;
  if (!token) {
    throw new Error('GITHUB_TOKEN or CCO_PAT is required');
  }

  const repoOwner = process.env.REPO_OWNER;
  const repoName = process.env.REPO_NAME;
  if (!repoOwner || !repoName) {
    throw new Error('REPO_OWNER and REPO_NAME are required');
  }

  // Parse event type
  const eventType = (process.env.EVENT_TYPE || 'workflow_dispatch') as EventType;

  // Parse event details
  const issueNumber = process.env.ISSUE_NUMBER ? parseInt(process.env.ISSUE_NUMBER, 10) : undefined;
  const prNumber = process.env.PR_NUMBER ? parseInt(process.env.PR_NUMBER, 10) : undefined;
  const branch = process.env.BRANCH || undefined;
  const reviewState = process.env.REVIEW_STATE as 'approved' | 'changes_requested' | 'commented' | undefined;
  const reviewBody = process.env.REVIEW_BODY || undefined;

  // Parse Claude configs
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

  // Parse options
  const maxEms = process.env.MAX_EMS ? parseInt(process.env.MAX_EMS, 10) : 3;
  const maxWorkersPerEm = process.env.MAX_WORKERS_PER_EM ? parseInt(process.env.MAX_WORKERS_PER_EM, 10) : 3;
  const reviewWaitMinutes = process.env.REVIEW_WAIT_MINUTES ? parseInt(process.env.REVIEW_WAIT_MINUTES, 10) : 5;
  const prLabel = process.env.PR_LABEL || 'cco';

  console.log('Event-Driven Orchestrator starting...');
  console.log(`  Event: ${eventType}`);
  console.log(`  Repo: ${repoOwner}/${repoName}`);
  if (issueNumber) console.log(`  Issue: #${issueNumber}`);
  if (prNumber) console.log(`  PR: #${prNumber}`);
  if (branch) console.log(`  Branch: ${branch}`);

  // Create orchestrator
  const orchestrator = new EventDrivenOrchestrator({
    repo: { owner: repoOwner, name: repoName },
    token,
    configs,
    options: { maxEms, maxWorkersPerEm, reviewWaitMinutes, prLabel }
  });

  // Build event
  const event: OrchestratorEvent = {
    type: eventType,
    issueNumber,
    prNumber,
    branch,
    reviewState,
    reviewBody
  };

  // Handle event
  await orchestrator.handleEvent(event);

  console.log('\nEvent handling complete');
}

main().catch(error => {
  console.error('Orchestrator failed:', error);
  process.exit(1);
});
