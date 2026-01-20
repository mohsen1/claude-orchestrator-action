#!/usr/bin/env node
/**
 * Event-driven orchestrator entry point
 *
 * Called by GitHub workflows on various events.
 * Reads event type and payload from environment, dispatches to orchestrator.
 *
 * IMPORTANT: This is designed to be truly event-driven.
 * Each invocation handles ONE event, updates state, and exits.
 * Long-running operations should trigger new workflow events.
 */
import { EventDrivenOrchestrator } from './index.js';
import { GitHubClient } from '../shared/github.js';
import { initDebugLogger, debugLog, flushDebugLog, debugLogError } from '../shared/debug-log.js';
async function main() {
    const startTime = Date.now();
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
    const eventType = (process.env.EVENT_TYPE || 'workflow_dispatch');
    // Parse event details
    const issueNumber = process.env.ISSUE_NUMBER ? parseInt(process.env.ISSUE_NUMBER, 10) : undefined;
    const prNumber = process.env.PR_NUMBER ? parseInt(process.env.PR_NUMBER, 10) : undefined;
    const branch = process.env.BRANCH || undefined;
    const reviewState = process.env.REVIEW_STATE;
    const reviewBody = process.env.REVIEW_BODY || undefined;
    // New internal dispatch event parameters
    const emId = process.env.EM_ID ? parseInt(process.env.EM_ID, 10) : undefined;
    const workerId = process.env.WORKER_ID ? parseInt(process.env.WORKER_ID, 10) : undefined;
    const retryCount = process.env.RETRY_COUNT ? parseInt(process.env.RETRY_COUNT, 10) : undefined;
    const idempotencyToken = process.env.IDEMPOTENCY_TOKEN || undefined;
    // Check debug mode
    const debugEnabled = process.env.CCO_DEBUG === 'true';
    // Initialize debug logger early
    const github = new GitHubClient(token, { owner: repoOwner, repo: repoName });
    const debugLogger = initDebugLogger(github, debugEnabled, issueNumber);
    await debugLog('orchestrator_start', {
        eventType,
        issueNumber,
        prNumber,
        branch,
        reviewState: reviewState || null,
        runId: process.env.GITHUB_RUN_ID
    });
    // Parse Claude configs
    const configsJson = process.env.CLAUDE_CONFIGS || '[]';
    let configs;
    try {
        configs = JSON.parse(configsJson);
    }
    catch (e) {
        await debugLogError('config_parse_error', e);
        throw new Error(`Failed to parse CLAUDE_CONFIGS: ${e.message}`);
    }
    if (!Array.isArray(configs) || configs.length === 0) {
        await debugLogError('config_validation_error', 'CLAUDE_CONFIGS must be a non-empty JSON array');
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
    console.log(`  Debug: ${debugEnabled ? 'ENABLED' : 'disabled'}`);
    if (issueNumber)
        console.log(`  Issue: #${issueNumber}`);
    if (prNumber)
        console.log(`  PR: #${prNumber}`);
    if (branch)
        console.log(`  Branch: ${branch}`);
    await debugLog('config_loaded', { maxEms, maxWorkersPerEm, reviewWaitMinutes, prLabel });
    // Create orchestrator
    const orchestrator = new EventDrivenOrchestrator({
        repo: { owner: repoOwner, name: repoName },
        token,
        configs,
        options: { maxEms, maxWorkersPerEm, reviewWaitMinutes, prLabel }
    });
    // Build event
    const event = {
        type: eventType,
        issueNumber,
        prNumber,
        branch,
        reviewState,
        reviewBody,
        emId,
        workerId,
        retryCount,
        idempotencyToken
    };
    // Handle event
    try {
        await debugLog('event_handler_start', { eventType });
        await orchestrator.handleEvent(event);
        await debugLog('event_handler_complete', {
            eventType,
            duration: Date.now() - startTime
        });
    }
    catch (error) {
        await debugLogError('event_handler_error', error);
        throw error;
    }
    finally {
        // Always flush debug logs before exiting
        const summary = debugLogger.getSummary();
        await debugLog('orchestrator_exit', {
            totalDuration: Date.now() - startTime,
            logEvents: summary.events,
            errors: summary.errors
        });
        await flushDebugLog();
    }
    console.log(`\nEvent handling complete (${Date.now() - startTime}ms)`);
}
main().catch(async (error) => {
    console.error('Orchestrator failed:', error);
    await debugLogError('fatal_error', error);
    await flushDebugLog();
    process.exit(1);
});
//# sourceMappingURL=run.js.map