#!/usr/bin/env node
/**
 * EM executable entry point
 * Called by GitHub Actions workflow
 */
import { EngineeringManager } from './index.js';
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
    const taskAssignment = process.env.TASK_ASSIGNMENT || '';
    const workBranch = process.env.WORK_BRANCH || '';
    const resume = process.env.RESUME === 'true';
    const sessionId = process.env.SESSION_ID;
    // Parse Claude configs
    const configsJson = process.env.CLAUDE_CONFIGS || '[]';
    const configs = JSON.parse(configsJson);
    // Parse options
    const maxWorkers = parseInt(process.env.MAX_WORKERS || '4', 10);
    const dispatchStaggerMs = parseInt(process.env.DISPATCH_STAGGER_MS || '2000', 10);
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
        taskAssignment,
        workBranch,
        configs,
        resume,
        sessionId,
        options: {
            maxWorkers,
            dispatchStaggerMs
        }
    };
    // Create and run EM
    const em = new EngineeringManager(context);
    if (resume) {
        if (!sessionId) {
            throw new Error('SESSION_ID is required when resuming');
        }
        await em.resume(sessionId);
    }
    else {
        await em.run();
    }
}
main().catch(error => {
    console.error('EM failed:', error);
    process.exit(1);
});
//# sourceMappingURL=run.js.map