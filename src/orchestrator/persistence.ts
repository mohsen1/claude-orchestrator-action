/**
 * State Persistence Layer
 * 
 * Handles reading and writing orchestrator state to the work branch.
 * State is stored in .orchestrator/state.json
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
    return state;
  } catch (error) {
    console.error('Failed to load state:', error);
    return null;
  }
}

/**
 * Save state to the current branch and commit
 */
export async function saveState(state: OrchestratorState, message?: string): Promise<void> {
  try {
    // Update timestamp
    const updatedState = touchState(state);
    
    // Ensure directory exists
    const dir = dirname(STATE_FILE_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    
    // Write state file
    writeFileSync(STATE_FILE_PATH, serializeState(updatedState));
    
    // Stage and commit
    const commitMessage = message || `chore: update orchestrator state (phase: ${state.phase})`;
    
    // Check if there are changes to commit
    const hasChanges = await GitOperations.hasUncommittedChanges();
    if (hasChanges) {
      await GitOperations.commitAndPush(commitMessage, [STATE_FILE_PATH]);
      console.log(`State saved and pushed: ${state.phase}`);
    } else {
      console.log('No state changes to commit');
    }
  } catch (error) {
    console.error('Failed to save state:', error);
    throw error;
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
