/**
 * Git operations for branch management and conflict resolution
 */
/**
 * Result of a rebase operation
 */
export interface RebaseResult {
    success: boolean;
    hasConflicts: boolean;
    conflictFiles: string[];
    error?: string;
}
/**
 * Git operations utilities
 */
export declare const GitOperations: {
    /**
     * Configure git identity (required for commits)
     * @param name - Git user name
     * @param email - Git user email
     * @returns void
     */
    configureIdentity(name?: string, email?: string): Promise<void>;
    /**
     * Create and checkout a new branch
     * @param branchName - Name of the branch to create
     * @param fromBranch - Branch or ref to create from (default: main)
     * @returns void
     */
    createBranch(branchName: string, fromBranch?: string): Promise<void>;
    /**
     * Checkout an existing branch
     * @param branchName - Name of the branch to checkout
     * @returns void
     */
    checkoutBranch(branchName: string): Promise<void>;
    /**
     * Add files, commit, and push
     * @param message - Commit message
     * @param files - Specific files to add (optional, defaults to all)
     * @returns void
     */
    commitAndPush(message: string, files?: string[]): Promise<void>;
    /**
     * Attempt to rebase onto a target branch
     * @param targetBranch - Branch to rebase onto
     * @returns Rebase result
     */
    rebase(targetBranch: string): Promise<RebaseResult>;
    /**
     * Continue a rebase after conflict resolution
     * @returns void
     */
    continueRebase(): Promise<void>;
    /**
     * Abort a failed rebase
     * @returns void
     */
    abortRebase(): Promise<void>;
    /**
     * Get list of conflicted files
     * @returns Array of conflicted file paths
     */
    getConflictedFiles(): Promise<string[]>;
    /**
     * Stage all conflicted files
     * @returns void
     */
    stageConflictedFiles(): Promise<void>;
    /**
     * Check if a string contains conflict markers
     * @param output - String to check
     * @returns true if conflict markers present
     */
    hasConflictMarkers(output: string): boolean;
    /**
     * Get the current branch name
     * @returns Current branch name
     */
    getCurrentBranch(): Promise<string>;
    /**
     * Get the current HEAD commit SHA
     * @returns Current commit SHA
     */
    getCurrentSha(): Promise<string>;
    /**
     * Check if there are uncommitted changes
     * @returns true if there are uncommitted changes
     */
    hasUncommittedChanges(): Promise<boolean>;
    /**
     * Get the list of modified files
     * @returns Array of modified file paths
     */
    getModifiedFiles(): Promise<string[]>;
    /**
     * Push the current branch to remote
     * @param branchName - Branch name to push (optional, uses current if not specified)
     * @returns void
     */
    push(branchName?: string): Promise<void>;
    /**
     * Delete a branch locally and remotely
     * @param branchName - Branch name to delete
     * @returns void
     */
    deleteBranch(branchName: string): Promise<void>;
    /**
     * Check if a remote branch exists
     * @param branchName - Branch name to check
     * @returns true if branch exists on remote
     */
    remoteBranchExists(branchName: string): Promise<boolean>;
};
//# sourceMappingURL=git.d.ts.map