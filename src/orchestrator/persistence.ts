/**
 * State Persistence Layer
 * 
 * Handles reading and writing orchestrator state to the work branch.
 * State is stored in .orchestrator/state.json
 * 
 * NOTE: State is only committed to the MAIN work branch, not to EM/worker branches.
 * This prevents merge conflicts when branches are merged back.
 * 
 * IMPORTANT: State saves use merge semantics to handle parallel execution.
 * When multiple workers save state simultaneously, their changes are merged
 * rather than overwritten.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { GitOperations } from '../shared/git.js';
import { 
  OrchestratorState, 
  STATE_FILE_PATH, 
  serializeState, 
  parseState,
  touchState,
  EMState,
  WorkerState
} from './state.js';

// Track if we're on the main work branch (where state should be committed)
let cachedWorkBranch: string | null = null;

/**
 * Merge two states, preferring the most complete/recent data
 * This handles the case where parallel workers save state simultaneously
 */
function mergeStates(localState: OrchestratorState, remoteState: OrchestratorState): OrchestratorState {
  // Start with the local state as base
  const merged = { ...localState };
  
  // Merge EMs - keep the most complete version of each
  merged.ems = localState.ems.map((localEM, idx) => {
    const remoteEM = remoteState.ems[idx];
    if (!remoteEM) return localEM;
    
    return mergeEM(localEM, remoteEM);
  });
  
  // If remote has more EMs (shouldn't happen but handle it)
  if (remoteState.ems.length > localState.ems.length) {
    merged.ems.push(...remoteState.ems.slice(localState.ems.length));
  }
  
  // Merge error history - combine unique errors
  const errorSet = new Set<string>();
  merged.errorHistory = [];
  for (const err of [...(localState.errorHistory || []), ...(remoteState.errorHistory || [])]) {
    const key = `${err.timestamp}-${err.message}`;
    if (!errorSet.has(key)) {
      errorSet.add(key);
      merged.errorHistory.push(err);
    }
  }
  merged.errorHistory.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  
  // Use the more advanced phase
  const phaseOrder = [
    'initialized', 'analyzing', 'project_setup', 'em_assignment',
    'worker_execution', 'worker_review', 'em_merging', 'em_review',
    'final_merge', 'final_review', 'complete', 'failed'
  ];
  const localPhaseIdx = phaseOrder.indexOf(localState.phase);
  const remotePhaseIdx = phaseOrder.indexOf(remoteState.phase);
  if (remotePhaseIdx > localPhaseIdx && remoteState.phase !== 'failed') {
    merged.phase = remoteState.phase;
  }
  
  // Use newer timestamp
  if (remoteState.updatedAt && localState.updatedAt && 
      remoteState.updatedAt > localState.updatedAt) {
    merged.updatedAt = remoteState.updatedAt;
  }
  
  // Merge finalPr - prefer existing
  if (!merged.finalPr && remoteState.finalPr) {
    merged.finalPr = remoteState.finalPr;
  }
  
  return merged;
}

/**
 * Merge two EM states, preferring the most complete version
 */
function mergeEM(local: EMState, remote: EMState): EMState {
  const merged = { ...local };
  
  // Merge workers - this is critical for parallel execution
  if (remote.workers.length > local.workers.length) {
    // Remote has more workers - use remote as base
    merged.workers = remote.workers.map((remoteWorker, idx) => {
      const localWorker = local.workers[idx];
      if (!localWorker) return remoteWorker;
      return mergeWorker(localWorker, remoteWorker);
    });
  } else if (local.workers.length > 0) {
    // Local has workers - merge with remote
    merged.workers = local.workers.map((localWorker, idx) => {
      const remoteWorker = remote.workers[idx];
      if (!remoteWorker) return localWorker;
      return mergeWorker(localWorker, remoteWorker);
    });
  } else if (remote.workers.length > 0) {
    // Local has no workers but remote does - use remote
    merged.workers = remote.workers;
  }
  
  // Use the more advanced status
  const statusOrder = ['pending', 'workers_running', 'workers_complete', 'pr_created', 'approved', 'merged', 'skipped', 'failed'];
  const localStatusIdx = statusOrder.indexOf(local.status);
  const remoteStatusIdx = statusOrder.indexOf(remote.status);
  
  // Don't downgrade from a working state to skipped/failed unless we really have no workers
  if (remote.status === 'skipped' || remote.status === 'failed') {
    if (merged.workers.length > 0 && merged.workers.some(w => w.status !== 'failed' && w.status !== 'skipped')) {
      // Keep local status if we have working workers
    } else if (remoteStatusIdx > localStatusIdx) {
      merged.status = remote.status;
      merged.error = remote.error;
    }
  } else if (remoteStatusIdx > localStatusIdx) {
    merged.status = remote.status;
  }
  
  // Use PR info if available
  if (!merged.prNumber && remote.prNumber) {
    merged.prNumber = remote.prNumber;
    merged.prUrl = remote.prUrl;
  }
  
  // Keep reviews addressed count (use max)
  merged.reviewsAddressed = Math.max(local.reviewsAddressed || 0, remote.reviewsAddressed || 0);
  
  return merged;
}

/**
 * Merge two worker states, preferring the most complete version
 */
function mergeWorker(local: WorkerState, remote: WorkerState): WorkerState {
  const merged = { ...local };
  
  // Use the more advanced status (but don't go backwards from merged/approved)
  const statusOrder = ['pending', 'in_progress', 'pr_created', 'changes_requested', 'approved', 'merged', 'skipped', 'failed'];
  const localStatusIdx = statusOrder.indexOf(local.status);
  const remoteStatusIdx = statusOrder.indexOf(remote.status);
  
  if (remoteStatusIdx > localStatusIdx) {
    merged.status = remote.status;
  }
  
  // Use PR info if available
  if (!merged.prNumber && remote.prNumber) {
    merged.prNumber = remote.prNumber;
    merged.prUrl = remote.prUrl;
  }
  
  // Keep reviews addressed count (use max)
  merged.reviewsAddressed = Math.max(local.reviewsAddressed || 0, remote.reviewsAddressed || 0);
  
  // Use completion time if available
  if (!merged.completedAt && remote.completedAt) {
    merged.completedAt = remote.completedAt;
  }
  
  // Keep error info
  if (!merged.error && remote.error) {
    merged.error = remote.error;
  }
  
  return merged;
}

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
 * Uses merge semantics to handle parallel execution safely
 */
export async function saveState(state: OrchestratorState, message?: string): Promise<void> {
  const { execa } = await import('execa');
  
  try {
    // Update timestamp
    let stateToSave = touchState(state);
    
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
      // Simple case: we're on the work branch
      // Still need to pull and merge to handle concurrent saves
      try {
        await execa('git', ['fetch', 'origin', cachedWorkBranch]);
        // Check if remote has changes
        const { stdout: diff } = await execa('git', ['rev-list', '--count', `HEAD..origin/${cachedWorkBranch}`]);
        if (parseInt(diff.trim(), 10) > 0) {
          // Remote has changes - pull and merge state
          await execa('git', ['pull', '--rebase', 'origin', cachedWorkBranch]);
          if (existsSync(STATE_FILE_PATH)) {
            const remoteContent = readFileSync(STATE_FILE_PATH, 'utf-8');
            const remoteState = parseState(remoteContent);
            stateToSave = mergeStates(stateToSave, remoteState);
            console.log('  Merged with remote state changes');
          }
        }
      } catch {
        // Pull failed, continue with local state
      }
      
      const dir = dirname(STATE_FILE_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(STATE_FILE_PATH, serializeState(stateToSave));
      
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
      // Need to switch to work branch, merge state, save, and switch back
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
        
        // Pull latest changes and MERGE with our state
        try {
          await execa('git', ['pull', '--rebase', 'origin', cachedWorkBranch]);
          // Load remote state and merge
          if (existsSync(STATE_FILE_PATH)) {
            const remoteContent = readFileSync(STATE_FILE_PATH, 'utf-8');
            const remoteState = parseState(remoteContent);
            stateToSave = mergeStates(stateToSave, remoteState);
            console.log('  Merged with remote state changes');
          }
        } catch {
          // Branch might not exist remotely yet, or no commits to pull
        }
        
        // Ensure directory exists
        const dir = dirname(STATE_FILE_PATH);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        
        // Write merged state file
        writeFileSync(STATE_FILE_PATH, serializeState(stateToSave));
        
        // Commit and push
        const commitMessage = message || `chore: update orchestrator state (phase: ${state.phase})`;
        await execa('git', ['add', STATE_FILE_PATH]);
        
        // Check if there are actual changes to commit
        try {
          const { stdout: status } = await execa('git', ['status', '--porcelain', STATE_FILE_PATH]);
          if (!status.trim()) {
            console.log('  No state changes to commit');
            return;
          }
        } catch {
          // Continue with commit attempt
        }
        
        await execa('git', ['commit', '-m', commitMessage]);
        
        // Try regular push first, with retry on conflict
        let pushAttempts = 0;
        const maxAttempts = 3;
        while (pushAttempts < maxAttempts) {
          try {
            await execa('git', ['push', '-u', 'origin', cachedWorkBranch]);
            break;
          } catch (pushErr) {
            pushAttempts++;
            if (pushAttempts >= maxAttempts) {
              console.error('  Push failed after max attempts');
              break;
            }
            // Pull, re-merge, and retry
            console.log(`  Push failed (attempt ${pushAttempts}), pulling and retrying...`);
            await execa('git', ['pull', '--rebase', 'origin', cachedWorkBranch]);
            
            // Re-read remote state and merge again
            if (existsSync(STATE_FILE_PATH)) {
              const remoteContent = readFileSync(STATE_FILE_PATH, 'utf-8');
              const remoteState = parseState(remoteContent);
              stateToSave = mergeStates(stateToSave, remoteState);
              writeFileSync(STATE_FILE_PATH, serializeState(stateToSave));
              await execa('git', ['add', STATE_FILE_PATH]);
              await execa('git', ['commit', '--amend', '--no-edit']);
            }
          }
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
