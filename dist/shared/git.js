/**
 * Git operations for branch management and conflict resolution
 */
import { execa } from 'execa';
/**
 * Git operations utilities
 */
export const GitOperations = {
    /**
     * Configure git identity (required for commits)
     * @param name - Git user name
     * @param email - Git user email
     * @returns void
     */
    async configureIdentity(name = 'Claude Orchestrator', email = 'actions@github.com') {
        try {
            await execa('git', ['config', 'user.name', name]);
            await execa('git', ['config', 'user.email', email]);
        }
        catch (error) {
            throw new Error(`Failed to configure git identity: ${error.message}`);
        }
    },
    /**
     * Create and checkout a new branch
     * @param branchName - Name of the branch to create
     * @param fromBranch - Branch or ref to create from (default: main)
     * @returns void
     */
    async createBranch(branchName, fromBranch = 'main') {
        try {
            // Fetch the base branch
            await execa('git', ['fetch', 'origin', fromBranch]);
            // Create and checkout the new branch
            await execa('git', ['checkout', '-B', branchName, `origin/${fromBranch}`]);
            // Set up tracking if fromBranch is not main
            if (fromBranch !== 'main') {
                await execa('git', ['branch', '--set-upstream-to=origin/main', branchName]);
            }
        }
        catch (error) {
            throw new Error(`Failed to create branch ${branchName} from ${fromBranch}: ${error.message}`);
        }
    },
    /**
     * Checkout an existing branch
     * @param branchName - Name of the branch to checkout
     * @returns void
     */
    async checkout(branchName) {
        try {
            await execa('git', ['checkout', branchName]);
        }
        catch (error) {
            throw new Error(`Failed to checkout branch ${branchName}: ${error.message}`);
        }
    },
    /**
     * @deprecated Use checkout instead
     */
    async checkoutBranch(branchName) {
        return this.checkout(branchName);
    },
    /**
     * Pull latest changes from remote
     * @param branchName - Branch name to pull (optional)
     * @returns void
     */
    async pull(branchName) {
        try {
            if (branchName) {
                await execa('git', ['pull', 'origin', branchName]);
            }
            else {
                await execa('git', ['pull']);
            }
        }
        catch (error) {
            throw new Error(`Failed to pull branch: ${error.message}`);
        }
    },
    /**
     * Add files, commit, and push
     * @param message - Commit message
     * @param branchOrFiles - Branch name to push, or specific files to add
     * @returns void
     */
    async commitAndPush(message, branchOrFiles) {
        try {
            // Ensure git identity is configured before committing
            await this.configureIdentity();
            // Stage files
            if (Array.isArray(branchOrFiles) && branchOrFiles.length > 0) {
                await execa('git', ['add', ...branchOrFiles]);
            }
            else {
                await execa('git', ['add', '-A']);
            }
            // Commit
            await execa('git', ['commit', '-m', message]);
            // Push (to specific branch if provided as string, otherwise push current HEAD)
            // First try to pull to incorporate any remote changes (e.g., from merged PRs)
            try {
                await execa('git', ['pull', '--rebase', 'origin', 'HEAD']);
            }
            catch {
                // Pull might fail if branch doesn't exist remotely yet, that's OK
            }
            if (typeof branchOrFiles === 'string') {
                await execa('git', ['push', '-u', 'origin', branchOrFiles]);
            }
            else {
                // Use origin HEAD to handle new branches without upstream
                await execa('git', ['push', '-u', 'origin', 'HEAD']);
            }
        }
        catch (error) {
            throw new Error(`Failed to commit and push: ${error.message}`);
        }
    },
    /**
     * Attempt to rebase onto a target branch
     * @param targetBranch - Branch to rebase onto
     * @returns Rebase result
     */
    async rebase(targetBranch) {
        try {
            // Fetch target branch
            await execa('git', ['fetch', 'origin', targetBranch]);
            // Attempt rebase
            await execa('git', ['rebase', `origin/${targetBranch}`]);
            return {
                success: true,
                hasConflicts: false,
                conflictFiles: []
            };
        }
        catch (error) {
            const stderr = error.stderr || '';
            // Check if it's a conflict error
            if (this.hasConflictMarkers(stderr)) {
                const conflictFiles = await this.getConflictedFiles();
                return {
                    success: false,
                    hasConflicts: true,
                    conflictFiles,
                    error: stderr
                };
            }
            return {
                success: false,
                hasConflicts: false,
                conflictFiles: [],
                error: stderr
            };
        }
    },
    /**
     * Continue a rebase after conflict resolution
     * @returns void
     */
    async continueRebase() {
        try {
            await execa('git', ['rebase', '--continue']);
        }
        catch (error) {
            throw new Error(`Failed to continue rebase: ${error.message}`);
        }
    },
    /**
     * Abort a failed rebase
     * @returns void
     */
    async abortRebase() {
        try {
            await execa('git', ['rebase', '--abort']);
        }
        catch (error) {
            throw new Error(`Failed to abort rebase: ${error.message}`);
        }
    },
    /**
     * Get list of conflicted files
     * @returns Array of conflicted file paths
     */
    async getConflictedFiles() {
        try {
            const { stdout } = await execa('git', [
                'diff',
                '--name-only',
                '--diff-filter=U'
            ]);
            return stdout
                .split('\n')
                .map(f => f.trim())
                .filter(f => f.length > 0);
        }
        catch (error) {
            throw new Error(`Failed to get conflicted files: ${error.message}`);
        }
    },
    /**
     * Stage all conflicted files
     * @returns void
     */
    async stageConflictedFiles() {
        try {
            // Add all files (including conflicted ones)
            await execa('git', ['add', '-u']);
        }
        catch (error) {
            throw new Error(`Failed to stage conflicted files: ${error.message}`);
        }
    },
    /**
     * Check if a string contains conflict markers
     * @param output - String to check
     * @returns true if conflict markers present
     */
    hasConflictMarkers(output) {
        return (output.includes('CONFLICT') ||
            output.includes('Merge conflict') ||
            output.includes('failed to merge'));
    },
    /**
     * Get the current branch name
     * @returns Current branch name
     */
    async getCurrentBranch() {
        try {
            const { stdout } = await execa('git', [
                'rev-parse',
                '--abbrev-ref',
                'HEAD'
            ]);
            return stdout.trim();
        }
        catch (error) {
            throw new Error(`Failed to get current branch: ${error.message}`);
        }
    },
    /**
     * Get the current HEAD commit SHA
     * @returns Current commit SHA
     */
    async getCurrentSha() {
        try {
            const { stdout } = await execa('git', ['rev-parse', 'HEAD']);
            return stdout.trim();
        }
        catch (error) {
            throw new Error(`Failed to get current SHA: ${error.message}`);
        }
    },
    /**
     * Check if there are uncommitted changes
     * @returns true if there are uncommitted changes
     */
    async hasUncommittedChanges() {
        try {
            const { stdout } = await execa('git', ['status', '--porcelain']);
            return stdout.trim().length > 0;
        }
        catch (error) {
            throw new Error(`Failed to check for uncommitted changes: ${error.message}`);
        }
    },
    /**
     * Get the list of modified files
     * @returns Array of modified file paths
     */
    async getModifiedFiles() {
        try {
            const { stdout } = await execa('git', [
                'diff',
                '--name-only',
                'HEAD'
            ]);
            return stdout
                .split('\n')
                .map(f => f.trim())
                .filter(f => f.length > 0);
        }
        catch (error) {
            throw new Error(`Failed to get modified files: ${error.message}`);
        }
    },
    /**
     * Push the current branch to remote
     * @param branchName - Branch name to push (optional, uses current if not specified)
     * @returns void
     */
    async push(branchName) {
        try {
            if (branchName) {
                await execa('git', ['push', '-u', 'origin', branchName]);
            }
            else {
                await execa('git', ['push']);
            }
        }
        catch (error) {
            throw new Error(`Failed to push branch: ${error.message}`);
        }
    },
    /**
     * Delete a branch locally and remotely
     * @param branchName - Branch name to delete
     * @returns void
     */
    async deleteBranch(branchName) {
        try {
            // Delete local branch
            await execa('git', ['branch', '-D', branchName]).catch(() => {
                // Ignore if local branch doesn't exist
            });
            // Delete remote branch
            await execa('git', ['push', 'origin', '--delete', branchName]).catch(() => {
                // Ignore if remote branch doesn't exist
            });
        }
        catch (error) {
            throw new Error(`Failed to delete branch ${branchName}: ${error.message}`);
        }
    },
    /**
     * Check if a remote branch exists
     * @param branchName - Branch name to check
     * @returns true if branch exists on remote
     */
    async remoteBranchExists(branchName) {
        try {
            await execa('git', [
                'ls-remote',
                '--heads',
                'origin',
                branchName
            ]);
            return true;
        }
        catch (error) {
            return false;
        }
    }
};
//# sourceMappingURL=git.js.map