/**
 * Git operations for branch management and conflict resolution
 */

import { execa } from 'execa';

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
export const GitOperations = {
  /**
   * Configure git identity (required for commits)
   * @param name - Git user name
   * @param email - Git user email
   * @returns void
   */
  async configureIdentity(
    name = 'Claude Orchestrator',
    email = 'actions@github.com'
  ): Promise<void> {
    try {
      await execa('git', ['config', 'user.name', name]);
      await execa('git', ['config', 'user.email', email]);
    } catch (error) {
      throw new Error(
        `Failed to configure git identity: ${(error as Error).message}`
      );
    }
  },

  /**
   * Create and checkout a new branch
   * @param branchName - Name of the branch to create
   * @param fromBranch - Branch or ref to create from (default: main)
   * @returns void
   */
  async createBranch(branchName: string, fromBranch = 'main'): Promise<void> {
    try {
      // Discard state file changes before branch operations to avoid conflicts
      try {
        await execa('git', ['checkout', '--', '.orchestrator/state.json']);
      } catch {
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
    } catch (error) {
      throw new Error(
        `Failed to create branch ${branchName} from ${fromBranch}: ${(error as Error).message}`
      );
    }
  },

  /**
   * Checkout an existing branch
   * @param branchName - Name of the branch to checkout
   * @returns void
   */
  async checkout(branchName: string): Promise<void> {
    try {
      // Discard changes to state file before checkout to avoid conflicts
      // State is always saved explicitly on the work branch
      try {
        await execa('git', ['checkout', '--', '.orchestrator/state.json']);
      } catch {
        // File might not exist, that's ok
      }
      
      // Try to checkout directly first
      try {
        await execa('git', ['checkout', branchName]);
        return;
      } catch {
        // Branch might not exist locally, try fetching it
      }
      
      // Fetch the branch from remote and checkout
      try {
        await execa('git', ['fetch', 'origin', branchName]);
        await execa('git', ['checkout', branchName]);
      } catch {
        // If that also fails, try creating from remote
        await execa('git', ['checkout', '-b', branchName, `origin/${branchName}`]);
      }
    } catch (error) {
      throw new Error(
        `Failed to checkout branch ${branchName}: ${(error as Error).message}`
      );
    }
  },

  /**
   * @deprecated Use checkout instead
   */
  async checkoutBranch(branchName: string): Promise<void> {
    return this.checkout(branchName);
  },

  /**
   * Pull latest changes from remote
   * @param branchName - Branch name to pull (optional)
   * @returns void
   */
  async pull(branchName?: string): Promise<void> {
    try {
      if (branchName) {
        await execa('git', ['pull', 'origin', branchName]);
      } else {
        await execa('git', ['pull']);
      }
    } catch (error) {
      throw new Error(
        `Failed to pull branch: ${(error as Error).message}`
      );
    }
  },

  /**
   * Add files, commit, and push
   * @param message - Commit message
   * @param branchOrFiles - Branch name to push, or specific files to add
   * @returns void
   */
  async commitAndPush(message: string, branchOrFiles?: string | string[]): Promise<void> {
    try {
      // Ensure git identity is configured before committing
      await this.configureIdentity();

      // Stage files
      if (Array.isArray(branchOrFiles) && branchOrFiles.length > 0) {
        await execa('git', ['add', ...branchOrFiles]);
      } else {
        // Add all except state file (state is managed separately on work branch only)
        await execa('git', ['add', '-A']);
        // Unstage state file if it was staged
        try {
          await execa('git', ['reset', 'HEAD', '.orchestrator/state.json']);
        } catch {
          // File might not exist or not be staged, that's ok
        }
      }

      // Check if there's anything staged to commit
      const { stdout: stagedFiles } = await execa('git', ['diff', '--cached', '--name-only']);
      const hasChanges = stagedFiles.trim().length > 0;
      
      if (hasChanges) {
        // Commit
        await execa('git', ['commit', '-m', message]);
      } else {
        console.log('No files to commit (after excluding state file)');
      }

      // Push (to specific branch if provided as string, otherwise push current HEAD)
      const branchToPush = typeof branchOrFiles === 'string' ? branchOrFiles : 'HEAD';
      try {
        await execa('git', ['push', '-u', 'origin', branchToPush]);
      } catch {
        // If normal push fails, fetch and try force-with-lease
        console.log('Normal push failed, fetching and retrying with force-with-lease...');
        try {
          await execa('git', ['fetch', 'origin']);
        } catch {
          // Fetch might fail if branch doesn't exist remotely yet, that's ok
        }
        await execa('git', ['push', '--force-with-lease', '-u', 'origin', branchToPush]);
      }
    } catch (error) {
      throw new Error(
        `Failed to commit and push: ${(error as Error).message}`
      );
    }
  },

  /**
   * Attempt to rebase onto a target branch
   * @param targetBranch - Branch to rebase onto
   * @returns Rebase result
   */
  async rebase(targetBranch: string): Promise<RebaseResult> {
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
    } catch (error) {
      const stderr = (error as any).stderr || '';

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
  async continueRebase(): Promise<void> {
    try {
      await execa('git', ['rebase', '--continue']);
    } catch (error) {
      throw new Error(
        `Failed to continue rebase: ${(error as Error).message}`
      );
    }
  },

  /**
   * Abort a failed rebase
   * @returns void
   */
  async abortRebase(): Promise<void> {
    try {
      await execa('git', ['rebase', '--abort']);
    } catch (error) {
      throw new Error(
        `Failed to abort rebase: ${(error as Error).message}`
      );
    }
  },

  /**
   * Get list of conflicted files
   * @returns Array of conflicted file paths
   */
  async getConflictedFiles(): Promise<string[]> {
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
    } catch (error) {
      throw new Error(
        `Failed to get conflicted files: ${(error as Error).message}`
      );
    }
  },

  /**
   * Stage all conflicted files
   * @returns void
   */
  async stageConflictedFiles(): Promise<void> {
    try {
      // Add all files (including conflicted ones)
      await execa('git', ['add', '-u']);
    } catch (error) {
      throw new Error(
        `Failed to stage conflicted files: ${(error as Error).message}`
      );
    }
  },

  /**
   * Check if a string contains conflict markers
   * @param output - String to check
   * @returns true if conflict markers present
   */
  hasConflictMarkers(output: string): boolean {
    return (
      output.includes('CONFLICT') ||
      output.includes('Merge conflict') ||
      output.includes('failed to merge')
    );
  },

  /**
   * Get the current branch name
   * @returns Current branch name
   */
  async getCurrentBranch(): Promise<string> {
    try {
      const { stdout } = await execa('git', [
        'rev-parse',
        '--abbrev-ref',
        'HEAD'
      ]);

      return stdout.trim();
    } catch (error) {
      throw new Error(
        `Failed to get current branch: ${(error as Error).message}`
      );
    }
  },

  /**
   * Get the current HEAD commit SHA
   * @returns Current commit SHA
   */
  async getCurrentSha(): Promise<string> {
    try {
      const { stdout } = await execa('git', ['rev-parse', 'HEAD']);

      return stdout.trim();
    } catch (error) {
      throw new Error(
        `Failed to get current SHA: ${(error as Error).message}`
      );
    }
  },

  /**
   * Check if there are uncommitted changes
   * @returns true if there are uncommitted changes
   */
  async hasUncommittedChanges(): Promise<boolean> {
    try {
      const { stdout } = await execa('git', ['status', '--porcelain']);

      return stdout.trim().length > 0;
    } catch (error) {
      throw new Error(
        `Failed to check for uncommitted changes: ${(error as Error).message}`
      );
    }
  },

  /**
   * Get the list of modified files
   * @returns Array of modified file paths
   */
  async getModifiedFiles(): Promise<string[]> {
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
    } catch (error) {
      throw new Error(
        `Failed to get modified files: ${(error as Error).message}`
      );
    }
  },

  /**
   * Push the current branch to remote
   * @param branchName - Branch name to push (optional, uses current if not specified)
   * @returns void
   */
  async push(branchName?: string): Promise<void> {
    const target = branchName || 'HEAD';
    try {
      try {
        await execa('git', ['push', '-u', 'origin', target]);
      } catch {
        // If normal push fails, fetch and try force-with-lease
        console.log('Normal push failed, fetching and retrying with force-with-lease...');
        try {
          await execa('git', ['fetch', 'origin']);
        } catch {
          // Fetch might fail if branch doesn't exist remotely yet
        }
        await execa('git', ['push', '--force-with-lease', '-u', 'origin', target]);
      }
    } catch (error) {
      throw new Error(
        `Failed to push branch: ${(error as Error).message}`
      );
    }
  },

  /**
   * Delete a branch locally and remotely
   * @param branchName - Branch name to delete
   * @returns void
   */
  async deleteBranch(branchName: string): Promise<void> {
    try {
      // Delete local branch
      await execa('git', ['branch', '-D', branchName]).catch(() => {
        // Ignore if local branch doesn't exist
      });

      // Delete remote branch
      await execa('git', ['push', 'origin', '--delete', branchName]).catch(
        () => {
          // Ignore if remote branch doesn't exist
        }
      );
    } catch (error) {
      throw new Error(
        `Failed to delete branch ${branchName}: ${(error as Error).message}`
      );
    }
  },

  /**
   * Check if a remote branch exists
   * @param branchName - Branch name to check
   * @returns true if branch exists on remote
   */
  async remoteBranchExists(branchName: string): Promise<boolean> {
    try {
      await execa('git', [
        'ls-remote',
        '--heads',
        'origin',
        branchName
      ]);

      return true;
    } catch (error) {
      return false;
    }
  }
};
