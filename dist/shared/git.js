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
            // Discard state file changes before branch operations to avoid conflicts
            try {
                await execa('git', ['checkout', '--', '.orchestrator/state.json']);
            }
            catch {
                // File might not exist, that's ok
            }
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
    /**
     * Clean up git state (abort rebases, merges, reset index)
     */
    async cleanupGitState() {
        // Abort any rebase in progress
        try {
            await execa('git', ['rebase', '--abort']);
        }
        catch {
            // No rebase in progress
        }
        // Abort any merge in progress
        try {
            await execa('git', ['merge', '--abort']);
        }
        catch {
            // No merge in progress
        }
        // Reset the index to HEAD (clears staging area)
        try {
            await execa('git', ['reset', 'HEAD']);
        }
        catch {
            // Might fail if no commits
        }
        // Discard all local changes
        try {
            await execa('git', ['checkout', '--', '.']);
        }
        catch {
            // Might fail if nothing to discard
        }
        // Clean untracked files
        try {
            await execa('git', ['clean', '-fd']);
        }
        catch {
            // Might fail
        }
    },
    async checkout(branchName) {
        try {
            // Clean up any broken git state first (conflicts, merges, rebases)
            await this.cleanupGitState();
            // Discard changes to state file before checkout to avoid conflicts
            // State is always saved explicitly on the work branch
            try {
                await execa('git', ['checkout', '--', '.orchestrator/state.json']);
            }
            catch {
                // File might not exist, that's ok
            }
            // Try to checkout directly first
            try {
                await execa('git', ['checkout', branchName]);
                return;
            }
            catch {
                // Branch might not exist locally, try fetching it
            }
            // Fetch the branch from remote
            try {
                await execa('git', ['fetch', 'origin', branchName]);
            }
            catch {
                // Fetch might fail if branch doesn't exist remotely yet
            }
            // Try checkout again after fetch
            try {
                await execa('git', ['checkout', branchName]);
                return;
            }
            catch {
                // Branch might not exist locally yet
            }
            // Delete local branch if it exists (might be stale)
            try {
                await execa('git', ['branch', '-D', branchName]);
            }
            catch {
                // Branch might not exist locally, that's fine
            }
            // Create local branch from remote
            await execa('git', ['checkout', '-b', branchName, `origin/${branchName}`]);
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
                // Use --rebase to handle divergent branches
                await execa('git', ['pull', '--rebase', 'origin', branchName]);
            }
            else {
                await execa('git', ['pull', '--rebase']);
            }
        }
        catch (error) {
            // If rebase fails, try to abort and do a hard reset to remote
            console.log('Pull with rebase failed, trying hard reset to remote...');
            try {
                await execa('git', ['rebase', '--abort']);
            }
            catch {
                // Rebase might not be in progress
            }
            if (branchName) {
                await execa('git', ['fetch', 'origin', branchName]);
                await execa('git', ['reset', '--hard', `origin/${branchName}`]);
            }
            else {
                throw new Error(`Failed to pull branch: ${error.message}`);
            }
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
                // Add all except state file (state is managed separately on work branch only)
                await execa('git', ['add', '-A']);
                // Unstage state file if it was staged
                try {
                    await execa('git', ['reset', 'HEAD', '.orchestrator/state.json']);
                }
                catch {
                    // File might not exist or not be staged, that's ok
                }
            }
            // Check if there's anything staged to commit
            const { stdout: stagedFiles } = await execa('git', ['diff', '--cached', '--name-only']);
            const hasChanges = stagedFiles.trim().length > 0;
            if (hasChanges) {
                // Commit
                await execa('git', ['commit', '-m', message]);
            }
            else {
                console.log('No files to commit (after excluding state file)');
            }
            // Push (to specific branch if provided as string, otherwise push current HEAD)
            const branchToPush = typeof branchOrFiles === 'string' ? branchOrFiles : 'HEAD';
            try {
                await execa('git', ['push', '-u', 'origin', branchToPush]);
            }
            catch {
                // If normal push fails, try pull-rebase then push (avoid force-push which can close PRs)
                console.log('Normal push failed, pulling and retrying...');
                try {
                    await execa('git', ['pull', '--rebase', 'origin', branchToPush]);
                    await execa('git', ['push', '-u', 'origin', branchToPush]);
                }
                catch {
                    // If pull-rebase fails (e.g., branch doesn't exist remotely), just push
                    console.log('Pull-rebase failed, trying direct push...');
                    await execa('git', ['push', '-u', 'origin', branchToPush]);
                }
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
        const target = branchName || 'HEAD';
        try {
            try {
                await execa('git', ['push', '-u', 'origin', target]);
            }
            catch (firstError) {
                // If normal push fails, try pull-rebase then push (avoid force-push which can close PRs)
                console.log(`Normal push failed: ${firstError.message.substring(0, 100)}. Trying pull-rebase...`);
                // Clean up any broken state first
                await this.cleanupGitState();
                try {
                    await execa('git', ['fetch', 'origin', target]);
                    await execa('git', ['pull', '--rebase', 'origin', target]);
                    await execa('git', ['push', '-u', 'origin', target]);
                }
                catch (rebaseError) {
                    // If pull-rebase fails, abort and try hard reset to remote then push
                    console.log(`Pull-rebase failed: ${rebaseError.message.substring(0, 100)}`);
                    // Abort any stuck rebase
                    try {
                        await execa('git', ['rebase', '--abort']);
                    }
                    catch {
                        // No rebase in progress
                    }
                    // If branch doesn't exist remotely, just push
                    try {
                        await execa('git', ['push', '-u', 'origin', target]);
                    }
                    catch (finalError) {
                        // Final attempt: hard reset to remote and push
                        console.log('Final attempt: hard reset to current HEAD and push...');
                        const currentCommit = (await execa('git', ['rev-parse', 'HEAD'])).stdout.trim();
                        await execa('git', ['reset', '--hard', currentCommit]);
                        await execa('git', ['push', '-u', 'origin', target]);
                    }
                }
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