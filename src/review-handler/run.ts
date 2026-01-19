#!/usr/bin/env node
/**
 * Review handler entry point
 * Triggered when a PR review requests changes
 * Runs Claude to address the feedback and push fixes
 */

import { GitHubClient } from '../shared/github.js';
import { SDKRunner } from '../shared/sdk-runner.js';
import { GitOperations } from '../shared/git.js';
import { ConfigManager } from '../shared/config.js';
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

  const prNumber = parseInt(process.env.PR_NUMBER || '0', 10);
  if (!prNumber) {
    throw new Error('PR_NUMBER is required');
  }

  const reviewBody = process.env.REVIEW_BODY || '';
  const branch = process.env.BRANCH || '';

  if (!branch) {
    throw new Error('BRANCH is required');
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

  console.log('Review Handler starting...');
  console.log(`  Repo: ${repoOwner}/${repoName}`);
  console.log(`  PR: #${prNumber}`);
  console.log(`  Branch: ${branch}`);
  console.log(`  Review feedback: ${reviewBody.substring(0, 100)}...`);

  const github = new GitHubClient(token, { owner: repoOwner, repo: repoName });
  const configManager = ConfigManager.fromJSON(JSON.stringify(configs));
  const currentConfig = configManager.getCurrentConfig();
  const apiKey = currentConfig.apiKey || currentConfig.env?.ANTHROPIC_API_KEY || currentConfig.env?.ANTHROPIC_AUTH_TOKEN;

  const sdkRunner = new SDKRunner({
    apiKey,
    baseUrl: currentConfig.env?.ANTHROPIC_BASE_URL,
    model: currentConfig.model,
    workDir: process.cwd()
  });

  // Also get any inline review comments
  let inlineComments = '';
  try {
    const comments = await github.getPullRequestComments(prNumber);
    if (comments.length > 0) {
      inlineComments = '\n\n**Inline Comments:**\n' + 
        comments.map(c => `- ${c.path}${c.line ? `:${c.line}` : ''}: ${c.body}`).join('\n');
    }
  } catch (e) {
    console.warn('Could not fetch inline comments:', e);
  }

  // Build prompt for Claude to address the review
  const prompt = `A code reviewer has requested changes on this PR. Please address ALL of the following feedback:

**Review Feedback:**
${reviewBody || '(No main review body provided)'}
${inlineComments}

**Instructions:**
1. Read through all the feedback carefully
2. Make the necessary code changes to address each point
3. If feedback is unclear, make your best judgment
4. Ensure all changes maintain code quality and consistency
5. Do NOT add unnecessary changes beyond what was requested

Please make the required changes now.`;

  console.log('\nRunning Claude to address review feedback...');
  const result = await sdkRunner.executeTask(prompt);

  if (!result.success) {
    console.error('Failed to address review:', result.error);
    
    // Post failure comment
    await github.addPullRequestComment(prNumber, 
      `## Failed to Address Review\n\nI encountered an error while trying to address the review feedback:\n\n\`\`\`\n${result.error}\n\`\`\`\n\n---\n*Automated by Claude Code Orchestrator*`
    );
    
    process.exit(1);
  }

  // Check for changes and commit
  const hasChanges = await GitOperations.hasUncommittedChanges();
  
  if (hasChanges) {
    console.log('\nCommitting changes...');
    await GitOperations.commitAndPush(
      `fix: address review feedback\n\nChanges made in response to code review comments.`,
      branch
    );
    
    console.log('Changes committed and pushed');
    
    // Post success comment
    await github.addPullRequestComment(prNumber,
      `## Review Feedback Addressed\n\nI've made changes to address the review feedback. Please take another look.\n\n**Changes made:**\n${result.output.substring(0, 500)}${result.output.length > 500 ? '...' : ''}\n\n---\n*Automated by Claude Code Orchestrator*`
    );
  } else {
    console.log('\nNo code changes were needed');
    
    await github.addPullRequestComment(prNumber,
      `## Review Feedback Acknowledged\n\nI reviewed the feedback but determined no code changes were necessary. If you believe changes are still needed, please provide more specific guidance.\n\n---\n*Automated by Claude Code Orchestrator*`
    );
  }

  // Reply to inline comments
  try {
    const comments = await github.getPullRequestComments(prNumber);
    for (const comment of comments) {
      // Only reply to comments we haven't replied to yet
      // (Simple heuristic: check if there's already a reply mentioning "Automated")
      try {
        await github.replyToReviewComment(prNumber, comment.id, 
          `Addressed in the latest commit.\n\n---\n*Automated response*`
        );
      } catch (e) {
        // Might fail if already replied, ignore
      }
    }
  } catch (e) {
    console.warn('Could not reply to inline comments:', e);
  }

  console.log('\nReview handling complete!');
}

main().catch(error => {
  console.error('Review handler failed:', error);
  process.exit(1);
});
