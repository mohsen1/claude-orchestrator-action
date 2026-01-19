/**
 * State Persistence Layer
 *
 * Handles reading and writing orchestrator state to the work branch.
 * State is stored in .orchestrator/state.json
 *
 * NOTE: State is only committed to the MAIN work branch, not to EM/worker branches.
 * This prevents merge conflicts when branches are merged back.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { GitOperations } from '../shared/git.js';
import { STATE_FILE_PATH, serializeState, parseState, touchState } from './state.js';
// Track if we're on the main work branch (where state should be committed)
let cachedWorkBranch = null;
/**
 * Set the main work branch name (call this when starting orchestration)
 */
export function setWorkBranch(branch) {
    cachedWorkBranch = branch;
}
/**
 * Load state from the current branch
 * Returns null if state file doesn't exist
 */
export async function loadState() {
    try {
        if (!existsSync(STATE_FILE_PATH)) {
            console.log(`State file not found at ${STATE_FILE_PATH}`);
            return null;
        }
        const content = readFileSync(STATE_FILE_PATH, 'utf-8');
        const state = parseState(content);
        console.log(`Loaded state: phase=${state.phase}, ems=${state.ems.length}`);
        // Cache the work branch from loaded state
        if (state.workBranch) {
            cachedWorkBranch = state.workBranch;
        }
        return state;
    }
    catch (error) {
        console.error('Failed to load state:', error);
        return null;
    }
}
/**
 * Save state to the work branch and commit
 * Only commits if on the main work branch to prevent conflicts
 */
export async function saveState(state, message) {
    try {
        // Update timestamp
        const updatedState = touchState(state);
        // Cache the work branch
        if (state.workBranch) {
            cachedWorkBranch = state.workBranch;
        }
        // Ensure directory exists
        const dir = dirname(STATE_FILE_PATH);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
        // Write state file locally (always do this for recovery)
        writeFileSync(STATE_FILE_PATH, serializeState(updatedState));
        // Check current branch
        const currentBranch = await GitOperations.getCurrentBranch();
        const isOnWorkBranch = currentBranch === cachedWorkBranch;
        // Only commit and push if on the main work branch
        if (isOnWorkBranch) {
            const commitMessage = message || `chore: update orchestrator state (phase: ${state.phase})`;
            const hasChanges = await GitOperations.hasUncommittedChanges();
            if (hasChanges) {
                await GitOperations.commitAndPush(commitMessage, [STATE_FILE_PATH]);
                console.log(`State saved and pushed: ${state.phase}`);
            }
            else {
                console.log('No state changes to commit');
            }
        }
        else {
            console.log(`State saved locally (not on work branch: ${currentBranch} vs ${cachedWorkBranch})`);
        }
    }
    catch (error) {
        console.error('Failed to save state:', error);
        throw error;
    }
}
/**
 * Load state from a specific branch
 */
export async function loadStateFromBranch(branch) {
    try {
        // Fetch and checkout the branch
        await GitOperations.checkout(branch);
        return await loadState();
    }
    catch (error) {
        console.error(`Failed to load state from branch ${branch}:`, error);
        return null;
    }
}
/**
 * Initialize state on a new work branch
 */
export async function initializeState(state, workBranch, baseBranch = 'main') {
    try {
        // Create and checkout work branch
        await GitOperations.createBranch(workBranch, baseBranch);
        // Save initial state
        await saveState(state, `chore: initialize orchestrator for issue #${state.issue.number}`);
        console.log(`Initialized state on branch ${workBranch}`);
    }
    catch (error) {
        console.error('Failed to initialize state:', error);
        throw error;
    }
}
/**
 * Find work branch for an issue by checking for state file
 */
export async function findWorkBranchForIssue(issueNumber) {
    // Work branches follow the pattern: cco/{issue_number}-*
    const branchPattern = `cco/${issueNumber}-`;
    try {
        // List remote branches matching pattern
        const { execa } = await import('execa');
        const { stdout } = await execa('git', ['branch', '-r', '--list', `origin/${branchPattern}*`]);
        const branches = stdout
            .split('\n')
            .map(b => b.trim().replace('origin/', ''))
            .filter(b => b.length > 0);
        if (branches.length === 0) {
            return null;
        }
        // Return the first matching branch (there should typically be only one)
        return branches[0];
    }
    catch (error) {
        console.error('Failed to find work branch:', error);
        return null;
    }
}
/**
 * Check if orchestration is already in progress for an issue
 */
export async function isOrchestrationInProgress(issueNumber) {
    const branch = await findWorkBranchForIssue(issueNumber);
    if (!branch) {
        return false;
    }
    const state = await loadStateFromBranch(branch);
    if (!state) {
        return false;
    }
    // In progress if not complete or failed
    return state.phase !== 'complete' && state.phase !== 'failed';
}
//# sourceMappingURL=persistence.js.map