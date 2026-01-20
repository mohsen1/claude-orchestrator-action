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
import { 
  OrchestratorState, 
  STATE_FILE_PATH, 
  serializeState, 
  parseState,
  touchState 
} from './state.js';

// Track if we're on the main work branch (where state should be committed)
let cachedWorkBranch: string | null = null;

/**
 * Set the main work branch name (call this when starting orchestration)
 */
export function setWorkBranch(branch: string): void {
  cachedWorkBranch = branch;
}

/**
 * Load state from the current branch
 * Returns null if state file doesn't exist
 */
export async function loadState(): Promise<OrchestratorState | null> {
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
  } catch (error) {
    console.error('Failed to load state:', error);
    return null;
  }
}

/**
 * Save state to the work branch and commit
 * Always commits to the work branch, even if currently on a different branch
 */
export async function saveState(state: OrchestratorState, message?: string): Promise<void> {
  const { execa } = await import('execa');
  
  try {
    // Update timestamp
    const updatedState = touchState(state);
    
    // Cache the work branch
    if (state.workBranch) {
      cachedWorkBranch = state.workBranch;
    }
    
    if (!cachedWorkBranch) {
      console.log('No work branch cached, cannot save state');
      return;
    }
    
    // Get current branch
    const currentBranch = await GitOperations.getCurrentBranch();
    const isOnWorkBranch = currentBranch === cachedWorkBranch;
    
    if (isOnWorkBranch) {
      // Simple case: we're on the work branch, just save normally
      const dir = dirname(STATE_FILE_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(STATE_FILE_PATH, serializeState(updatedState));
      
      const commitMessage = message || `chore: update orchestrator state (phase: ${state.phase})`;
      const hasChanges = await GitOperations.hasUncommittedChanges();
      if (hasChanges) {
        await GitOperations.commitAndPush(commitMessage, [STATE_FILE_PATH]);
        console.log(`State saved and pushed: ${state.phase}`);
      } else {
        console.log('No state changes to commit');
      }
    } else {
      // Complex case: we're on a different branch
      // Need to switch to work branch, save state, and switch back
      console.log(`Saving state to work branch (currently on ${currentBranch})...`);
      
      // Check for uncommitted changes (excluding state file)
      let needStash = false;
      try {
        const { stdout } = await execa('git', ['status', '--porcelain']);
        // Filter out the state file from the check
        const otherChanges = stdout.split('\n').filter(line => 
          line.trim() && !line.includes('.orchestrator/state.json')
        );
        needStash = otherChanges.length > 0;
      } catch {
        // Ignore status errors
      }
      
      // Stash changes if needed
      if (needStash) {
        try {
          await execa('git', ['stash', 'push', '-m', 'saveState: temporary stash']);
          console.log('  Stashed uncommitted changes');
        } catch (err) {
          console.log('  Could not stash changes:', (err as Error).message);
        }
      }
      
      try {
        // Discard any local state file changes
        try {
          await execa('git', ['checkout', '--', STATE_FILE_PATH]);
        } catch {
          // File might not exist, that's OK
        }
        
        // Checkout work branch
        await execa('git', ['checkout', cachedWorkBranch]);
        
        // Pull latest changes to avoid conflicts (but don't fail if branch doesn't exist remotely yet)
        try {
          await execa('git', ['pull', '--rebase', 'origin', cachedWorkBranch]);
        } catch {
          // Branch might not exist remotely yet, or no commits to pull
        }
        
        // Ensure directory exists
        const dir = dirname(STATE_FILE_PATH);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        
        // Write state file
        writeFileSync(STATE_FILE_PATH, serializeState(updatedState));
        
        // Commit and push (use regular push, NOT force-push to avoid auto-closing PRs)
        const commitMessage = message || `chore: update orchestrator state (phase: ${state.phase})`;
        await execa('git', ['add', STATE_FILE_PATH]);
        await execa('git', ['commit', '-m', commitMessage]);
        
        // Try regular push first
        try {
          await execa('git', ['push', '-u', 'origin', cachedWorkBranch]);
        } catch (pushErr) {
          // If regular push fails, pull and retry (but NOT force push!)
          console.log('  Push failed, pulling and retrying...');
          await execa('git', ['pull', '--rebase', 'origin', cachedWorkBranch]);
          await execa('git', ['push', '-u', 'origin', cachedWorkBranch]);
        }
        console.log(`  State saved and pushed to ${cachedWorkBranch}: ${state.phase}`);
        
      } finally {
        // Switch back to original branch
        try {
          await execa('git', ['checkout', currentBranch]);
          console.log(`  Switched back to ${currentBranch}`);
        } catch (err) {
          console.error('  Failed to switch back to original branch:', (err as Error).message);
        }
        
        // Pop stash if we stashed
        if (needStash) {
          try {
            await execa('git', ['stash', 'pop']);
            console.log('  Restored stashed changes');
          } catch (err) {
            console.log('  Could not restore stash:', (err as Error).message);
          }
        }
      }
    }
  } catch (error) {
    console.error('Failed to save state:', error);
    // Don't throw - state save failures shouldn't crash orchestration
    // The progress comment will still show current status
  }
}

/**
 * Load state from a specific branch
 */
export async function loadStateFromBranch(branch: string): Promise<OrchestratorState | null> {
  try {
    // Fetch and checkout the branch
    await GitOperations.checkout(branch);
    return await loadState();
  } catch (error) {
    console.error(`Failed to load state from branch ${branch}:`, error);
    return null;
  }
}

/**
 * Initialize state on a new work branch
 */
export async function initializeState(
  state: OrchestratorState,
  workBranch: string,
  baseBranch: string = 'main'
): Promise<void> {
  try {
    // Create and checkout work branch
    await GitOperations.createBranch(workBranch, baseBranch);
    
    // Save initial state
    await saveState(state, `chore: initialize orchestrator for issue #${state.issue.number}`);
    
    console.log(`Initialized state on branch ${workBranch}`);
  } catch (error) {
    console.error('Failed to initialize state:', error);
    throw error;
  }
}

/**
 * Find work branch for an issue by checking for state file
 */
export async function findWorkBranchForIssue(issueNumber: number): Promise<string | null> {
  // Work branches follow the pattern: cco/{issue_number}-*
  const branchPattern = `cco/${issueNumber}-`;
  
  try {
    const { execa } = await import('execa');
    
    // Fetch remote branches first to ensure we see all branches
    try {
      await execa('git', ['fetch', 'origin']);
    } catch {
      // Fetch might fail in some cases, continue anyway
    }
    
    // List remote branches matching pattern
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
  } catch (error) {
    console.error('Failed to find work branch:', error);
    return null;
  }
}

/**
 * Check if orchestration is already in progress for an issue
 */
export async function isOrchestrationInProgress(issueNumber: number): Promise<boolean> {
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
