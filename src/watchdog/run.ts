#!/usr/bin/env node
/**
 * Watchdog executable entry point
 * Called by GitHub Actions workflow
 */

import { Watchdog } from './index.js';

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

  const stallTimeoutMinutes = parseInt(process.env.STALL_TIMEOUT_MINUTES || '60', 10);

  // Build context
  const context = {
    repo: {
      owner: repoOwner,
      repo: repoName
    },
    token,
    stallTimeoutMinutes
  };

  // Create and run Watchdog
  const watchdog = new Watchdog(context);
  const stalled = await watchdog.checkStalled();

  console.log(`Found ${stalled.length} stalled components`);

  // Attempt recovery for each stalled component
  for (const component of stalled) {
    console.log(`Attempting recovery for ${component.type}...`);
    const recovered = await watchdog.recoverStalled(component);

    if (recovered) {
      console.log(`Successfully recovered ${component.type}`);
    } else {
      console.log(`Failed to recover ${component.type}`);
    }
  }

  // Set output for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    const fs = await import('fs/promises');
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `stalled_count=${stalled.length}\n`
    );
    await fs.appendFile(
      process.env.GITHUB_OUTPUT,
      `stalled_json=${JSON.stringify(stalled)}\n`
    );
  }
}

main().catch(error => {
  console.error('Watchdog failed:', error);
  process.exit(1);
});
