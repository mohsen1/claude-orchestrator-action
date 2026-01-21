/**
 * Event-Driven Orchestrator
 * 
 * Handles GitHub events and manages state transitions.
 * Each invocation:
 * 1. Reads current state from .orchestrator/state.json
 * 2. Determines action based on event and state
 * 3. Executes action
 * 4. Updates state and exits
 */

import { execa } from 'execa';
import { GitHubClient } from '../shared/github.js';
import { GitOperations } from '../shared/git.js';
import { SDKRunner } from '../shared/sdk-runner.js';
import { ClaudeCodeRunner, generateSessionId } from '../shared/claude.js';
import { ConfigManager } from '../shared/config.js';
import { extractJson } from '../shared/json.js';
import { slugify, getDirectorBranch } from '../shared/branches.js';
import {
  OrchestratorState,
  EMState,
  createInitialState,
  areAllWorkersComplete,
  hasSuccessfulWorkers,
  getNextPendingWorker,
  addErrorToHistory
} from './state.js';
import { loadState, saveState, initializeState, findWorkBranchForIssue } from './persistence.js';
import type { ClaudeConfig } from '../shared/config.js';
import {
  STATUS_LABELS,
  TYPE_LABELS,
  phaseToLabel,
  ORCHESTRATOR_COMMENT_MARKER,
  ORCHESTRATOR_REVIEW_MARKER
} from '../shared/labels.js';
import { debugLog } from '../shared/debug-log.js';

export type EventType = 
  // External GitHub events
  | 'issue_labeled'        // Start orchestration
  | 'issue_closed'         // Issue closed - cleanup everything
  | 'push'                 // Code pushed to a branch
  | 'pull_request_opened'  // PR opened
  | 'pull_request_merged'  // PR merged
  | 'pull_request_review'  // Review submitted
  | 'workflow_dispatch'    // Manual trigger
  | 'schedule'            // Scheduled check
  // Internal dispatch events (new)
  | 'start_em'            // Start a specific EM
  | 'execute_worker'      // Execute a specific worker
  | 'create_em_pr'        // Create PR for EM after workers done
  | 'check_completion'    // Check if orchestration is complete
  | 'retry_failed';       // Retry a failed worker/EM

export interface OrchestratorEvent {
  type: EventType;
  issueNumber?: number;
  prNumber?: number;
  branch?: string;
  reviewState?: 'approved' | 'changes_requested' | 'commented';
  reviewBody?: string;
  // New fields for internal dispatch events
  emId?: number;          // EM ID (for start_em, execute_worker, create_em_pr)
  workerId?: number;      // Worker ID (for execute_worker)
  retryCount?: number;    // Retry attempt number (for retry_failed)
  idempotencyToken?: string; // Token to prevent duplicate processing
}

export interface OrchestratorContext {
  repo: { owner: string; name: string };
  token: string;
  configs: ClaudeConfig[];
  options?: {
    maxEms?: number;
    maxWorkersPerEm?: number;
    reviewWaitMinutes?: number;
    prLabel?: string;
  };
}

export class EventDrivenOrchestrator {
  private ctx: OrchestratorContext;
  private github: GitHubClient;
  private configManager: ConfigManager;
  private claude: ClaudeCodeRunner;
  private sdkRunner: SDKRunner;
  private state: OrchestratorState | null = null;

  constructor(ctx: OrchestratorContext) {
    this.ctx = ctx;
    this.github = new GitHubClient(ctx.token, { owner: ctx.repo.owner, repo: ctx.repo.name });
    this.configManager = ConfigManager.fromJSON(JSON.stringify(ctx.configs));

    const currentConfig = this.configManager.getCurrentConfig();
    const apiKey = currentConfig.apiKey || currentConfig.env?.ANTHROPIC_API_KEY || currentConfig.env?.ANTHROPIC_AUTH_TOKEN;

    this.claude = new ClaudeCodeRunner({
      apiKey,
      baseUrl: currentConfig.env?.ANTHROPIC_BASE_URL,
      model: currentConfig.model
    });

    this.sdkRunner = new SDKRunner({
      apiKey,
      baseUrl: currentConfig.env?.ANTHROPIC_BASE_URL,
      model: currentConfig.model,
      workDir: process.cwd()
    });
  }

  /**
   * Dispatch an internal event via workflow_dispatch
   * Generates idempotency token and handles retries
   */
  private async dispatchEvent(
    eventType: 'start_em' | 'execute_worker' | 'create_em_pr' | 'check_completion' | 'retry_failed',
    inputs: {
      issue_number: number;
      em_id?: number;
      worker_id?: number;
      retry_count?: number;
    }
  ): Promise<void> {
    if (!this.state) {
      throw new Error('Cannot dispatch event: no state loaded');
    }

    // Generate idempotency token: eventType-issue-em-worker-timestamp
    const tokenParts = [
      eventType,
      inputs.issue_number,
      inputs.em_id ?? 'none',
      inputs.worker_id ?? 'none',
      Date.now()
    ];
    const idempotencyToken = tokenParts.join('-');

    const workflowInputs: Record<string, string> = {
      event_type: eventType,
      issue_number: inputs.issue_number.toString(),
    };

    if (inputs.em_id !== undefined) {
      workflowInputs.em_id = inputs.em_id.toString();
    }
    if (inputs.worker_id !== undefined) {
      workflowInputs.worker_id = inputs.worker_id.toString();
    }
    if (inputs.retry_count !== undefined) {
      workflowInputs.retry_count = inputs.retry_count.toString();
    }

    try {
      await this.github.dispatchWorkflow(
        'orchestrator.yml',
        'main', // Always dispatch from main branch
        workflowInputs,
        {
          maxRetries: 3,
          retryDelayMs: 1000,
          idempotencyToken
        }
      );
      
      await debugLog('event_dispatched', {
        eventType,
        issueNumber: inputs.issue_number,
        emId: inputs.em_id,
        workerId: inputs.worker_id,
        idempotencyToken
      });
    } catch (error) {
      const errorMsg = `Failed to dispatch ${eventType}: ${(error as Error).message}`;
      console.error(errorMsg);
      this.addErrorToHistory(errorMsg, `dispatch-${eventType}`);
      throw error;
    }
  }

  /**
   * Add error to history (preserves all errors)
   */
  private addErrorToHistory(message: string, context?: string): void {
    if (!this.state) return;
    
    if (!this.state.errorHistory) {
      this.state.errorHistory = [];
    }
    
    this.state.errorHistory.push({
      timestamp: new Date().toISOString(),
      phase: this.state.phase,
      message: message.substring(0, 500),
      context
    });
  }

  /**
   * Update the phase and sync the label on the issue
   */
  private async setPhase(phase: OrchestratorState['phase']): Promise<void> {
    if (!this.state) return;
    
    const previousPhase = this.state.phase;
    this.state.phase = phase;
    
    await debugLog('phase_transition', { 
      from: previousPhase, 
      to: phase,
      issueNumber: this.state.issue.number 
    }, phase);
    
    // Update the phase label on the issue
    const phaseLabel = phaseToLabel(phase);
    if (phaseLabel) {
      await this.github.setPhaseLabel(this.state.issue.number, phaseLabel);
    }
  }

  /**
   * Generate a smart executive summary based on current state
   */
  private generateExecutiveSummary(ctx: {
    phase: string;
    issueTitle: string;
    emsCount: number;
    totalWorkers: number;
    mergedWorkers: number;
    failedWorkers: number;
    inProgressWorkers: number;
    mergedEMs: number;
    finalPr?: { number: number; url: string } | null;
    errorCount: number;
    emFocusAreas: string[];
  }): string {
    const { phase, issueTitle, emsCount, totalWorkers, mergedWorkers, failedWorkers, 
            inProgressWorkers, mergedEMs, finalPr, errorCount, emFocusAreas } = ctx;

    // Generate contextual summary based on phase and progress
    const activeTeams = emFocusAreas.slice(0, 3).join(', ');
    const moreTeams = emsCount > 3 ? ` and ${emsCount - 3} more` : '';

    switch (phase) {
      case 'initialized':
        return `Starting automated implementation of "${issueTitle}". The orchestrator will analyze requirements and coordinate parallel development teams.`;
      
      case 'analyzing':
        return `Breaking down "${issueTitle}" into parallel workstreams. Identifying key components and assigning specialized teams.`;
      
      case 'project_setup':
        return `Initializing project foundation for "${issueTitle}". Setting up dependencies, configuration, and shared infrastructure before parallel work begins.`;
      
      case 'em_assignment':
        return `Mobilizing ${emsCount} development teams: ${activeTeams}${moreTeams}. Each team will work independently on their focus area.`;
      
      case 'worker_execution':
        return `${inProgressWorkers} developer(s) actively coding across ${emsCount} teams. Building: ${activeTeams}${moreTeams}. Progress: ${mergedWorkers}/${totalWorkers} tasks complete.`;
      
      case 'worker_review':
        return `Code review in progress. ${mergedWorkers}/${totalWorkers} implementations merged${failedWorkers > 0 ? `, ${failedWorkers} need attention` : ''}. Teams: ${activeTeams}${moreTeams}.`;
      
      case 'em_merging':
        return `Integrating team work. ${mergedEMs}/${emsCount} teams merged into main branch. Resolving any integration issues.`;
      
      case 'em_review':
        return `Team PRs ready for final review. ${emsCount} specialized implementations covering: ${activeTeams}${moreTeams}.`;
      
      case 'final_merge':
        return `All ${emsCount} teams complete! Creating final PR to deliver "${issueTitle}". ${totalWorkers} individual contributions integrated.`;
      
      case 'final_review':
        return `Final implementation ready for review!${finalPr ? ` [PR #${finalPr.number}](${finalPr.url})` : ''} Includes work from ${emsCount} teams and ${mergedWorkers} merged contributions.`;
      
      case 'complete':
        return `"${issueTitle}" successfully delivered! ${emsCount} teams collaborated on ${mergedWorkers} implementations. All code merged to main.`;
      
      case 'failed':
        return `Implementation paused due to ${errorCount} error(s). Review the log below and consider restarting. Progress: ${mergedWorkers}/${totalWorkers} tasks were completed.`;
      
      default:
        return `Orchestrating "${issueTitle}" with ${emsCount} teams and ${totalWorkers} parallel tasks.`;
    }
  }

  /**
   * Post or update progress comment on the issue
   */
  private async updateProgressComment(error?: string): Promise<void> {
    if (!this.state) return;

    // Add error to history if provided
    if (error) {
      this.addErrorToHistory(error);
    }

    const { issue, ems, phase, workBranch, finalPr, createdAt, errorHistory } = this.state;
    
    // Calculate duration
    const startTime = new Date(createdAt).getTime();
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const minutes = Math.floor(elapsed / 60);
    const seconds = elapsed % 60;
    const durationStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
    
    // Build status emoji based on phase
    const phaseEmoji: Record<string, string> = {
      initialized: '🚀',
      analyzing: '🔍',
      project_setup: '📦',
      em_assignment: '👥',
      worker_execution: '⚙️',
      worker_review: '👀',
      em_merging: '🔀',
      em_review: '📝',
      final_merge: '✅',
      final_review: '🎯',
      complete: '🎉',
      failed: '❌'
    };

    const statusEmoji = phaseEmoji[phase] || '📋';
    const phaseLabel = phase.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    // Count stats
    const totalWorkers = ems.reduce((sum, em) => sum + em.workers.length, 0);
    const mergedWorkers = ems.reduce((sum, em) => sum + em.workers.filter(w => w.status === 'merged').length, 0);
    const mergedEMs = ems.filter(em => em.status === 'merged').length;
    const failedWorkers = ems.reduce((sum, em) => sum + em.workers.filter(w => w.status === 'failed' || w.status === 'skipped').length, 0);
    const inProgressWorkers = ems.reduce((sum, em) => sum + em.workers.filter(w => w.status === 'in_progress' || w.status === 'pr_created').length, 0);

    // Build executive summary - generate smart summary using context
    const executiveSummary = this.generateExecutiveSummary({
      phase,
      issueTitle: issue.title,
      emsCount: ems.length,
      totalWorkers,
      mergedWorkers,
      failedWorkers,
      inProgressWorkers,
      mergedEMs,
      finalPr,
      errorCount: errorHistory?.length || 0,
      emFocusAreas: ems.map(em => em.focusArea)
    });

    // Add progress indicator
    const progressPercent = totalWorkers > 0 ? Math.round((mergedWorkers / totalWorkers) * 100) : 0;
    const progressBar = totalWorkers > 0 
      ? `[${'█'.repeat(Math.floor(progressPercent / 10))}${'░'.repeat(10 - Math.floor(progressPercent / 10))}] ${progressPercent}%`
      : '';

    // Build EM/Worker status table
    let emTable = '';
    if (ems.length > 0) {
      emTable = `\n### Teams & Workers\n\n| Team | Focus | Workers | Status |\n|------|-------|---------|--------|\n`;
      
      for (const em of ems) {
        const completedWorkers = em.workers.filter(w => w.status === 'merged').length;
        const totalEmWorkers = em.workers.length;
        const workerStatus = totalEmWorkers > 0 ? `${completedWorkers}/${totalEmWorkers}` : 'Pending';
        
        let emStatusDisplay = em.status as string;
        if (em.status === 'merged') emStatusDisplay = '✅ Merged';
        else if (em.status === 'pr_created') emStatusDisplay = '🔄 PR #' + (em.prNumber || '');
        else if (em.status === 'workers_running') emStatusDisplay = '⚙️ Working';
        else if (em.status === 'workers_complete') emStatusDisplay = '📝 Workers Done';
        else if (em.status === 'approved') emStatusDisplay = '✅ Approved';
        else if (em.status === 'changes_requested') emStatusDisplay = '📝 Changes Requested';
        else if (em.status === 'skipped') emStatusDisplay = '⏭️ Skipped';
        else if (em.status === 'failed') emStatusDisplay = '❌ Failed';
        else if (em.status === 'pending') emStatusDisplay = '⏳ Pending';
        
        emTable += `| EM-${em.id} | ${em.focusArea.substring(0, 30)}${em.focusArea.length > 30 ? '...' : ''} | ${workerStatus} | ${emStatusDisplay} |\n`;
      }

      // Add worker details for ALL EMs that have workers
      for (const em of ems.filter(e => e.workers.length > 0)) {
        emTable += `\n<details><summary>Workers for EM-${em.id}: ${em.focusArea.substring(0, 25)}</summary>\n\n`;
        emTable += `| Worker | Task | Status |\n|--------|------|--------|\n`;
        for (const worker of em.workers) {
          let wStatusDisplay = worker.status as string;
          if (worker.status === 'merged') wStatusDisplay = '✅ Merged';
          else if (worker.status === 'pr_created') wStatusDisplay = `🔄 [PR #${worker.prNumber}](${worker.prUrl})`;
          else if (worker.status === 'in_progress') wStatusDisplay = '⚙️ Working';
          else if (worker.status === 'changes_requested') wStatusDisplay = '📝 Changes Requested';
          else if (worker.status === 'approved') wStatusDisplay = '✅ Approved';
          else if (worker.status === 'skipped') wStatusDisplay = '⏭️ Skipped';
          else if (worker.status === 'failed') wStatusDisplay = '❌ Failed';
          else wStatusDisplay = '⏳ Pending';
          
          emTable += `| W-${worker.id} | ${worker.task.substring(0, 40)}${worker.task.length > 40 ? '...' : ''} | ${wStatusDisplay} |\n`;
        }
        emTable += `\n</details>\n`;
      }
    }

    // Build error history section (show ALL errors)
    let errorSection = '';
    if (errorHistory && errorHistory.length > 0) {
      errorSection = `\n### ⚠️ Errors (${errorHistory.length})\n`;
      errorSection += `<details><summary>Click to expand error log</summary>\n\n`;
      for (const err of errorHistory) {
        const errTime = new Date(err.timestamp).toISOString().substring(11, 19);
        errorSection += `**[${errTime}] ${err.phase}**\n\`\`\`\n${err.message}\n\`\`\`\n`;
        if (err.context) {
          errorSection += `Context: ${err.context}\n`;
        }
        errorSection += '\n';
      }
      errorSection += `</details>\n`;
    }

    // Build final PR section
    const finalPRSection = finalPr 
      ? `\n### Final PR\n[#${finalPr.number}](${finalPr.url}) - Reviews addressed: ${finalPr.reviewsAddressed || 0}\n`
      : '';

    // Build the full comment with hidden marker for reliable detection
    const body = `${ORCHESTRATOR_COMMENT_MARKER}
## Claude Code Orchestrator Status

> ${executiveSummary}

${statusEmoji} **Phase:** ${phaseLabel} ${progressBar}

| | |
|---|---|
| **Branch** | \`${workBranch}\` |
| **Duration** | ${durationStr} |
| **EMs** | ${mergedEMs}/${ems.length} merged |
| **Workers** | ${mergedWorkers}/${totalWorkers} merged |
${emTable}${finalPRSection}${errorSection}
---
*Last updated: ${new Date().toISOString()}*
*Automated by [Claude Code Orchestrator](https://github.com/mohsen1/claude-orchestrator-action)*`;

    try {
      await this.github.updateIssueComment(issue.number, body);
    } catch (err) {
      console.error('Failed to update progress comment:', err);
    }
  }

  /**
   * Main entry point - handle an event
   * 
   * IMPORTANT: This method should handle ONE event and exit.
   * Long-running work is done by Claude, and state is persisted.
   * The next event (PR merge, review, etc.) triggers the next step.
   */
  async handleEvent(event: OrchestratorEvent): Promise<void> {
    console.log(`\n=== Handling event: ${event.type} ===`);
    console.log(`Event details:`, JSON.stringify(event, null, 2));

    await debugLog('handle_event_start', { 
      type: event.type,
      issueNumber: event.issueNumber,
      prNumber: event.prNumber,
      branch: event.branch
    });

    try {
      switch (event.type) {
        case 'issue_labeled':
          await debugLog('dispatch_issue_labeled');
          await this.handleIssueLabeled(event);
          break;
        case 'issue_closed':
          await debugLog('dispatch_issue_closed');
          await this.handleIssueClosed(event);
          break;
        case 'pull_request_merged':
          await debugLog('dispatch_pr_merged', { prNumber: event.prNumber });
          await this.handlePRMerged(event);
          break;
        case 'pull_request_review':
          await debugLog('dispatch_pr_review', { prNumber: event.prNumber, reviewState: event.reviewState });
          await this.handlePRReview(event);
          break;
        case 'workflow_dispatch':
          // workflow_dispatch can either start new or continue existing
          if (event.issueNumber) {
            const existingBranch = await findWorkBranchForIssue(event.issueNumber);
            if (existingBranch) {
              await debugLog('dispatch_progress_check', { existingBranch });
              await this.handleProgressCheck({ ...event, branch: existingBranch });
            } else {
              await debugLog('dispatch_new_orchestration');
              // No existing branch - start new orchestration
              await this.handleIssueLabeled(event);
            }
          } else {
            await debugLog('dispatch_progress_check', { branch: event.branch });
            await this.handleProgressCheck(event);
          }
          break;
        case 'schedule':
          await debugLog('dispatch_schedule');
          await this.handleProgressCheck(event);
          break;
        // New internal dispatch events
        case 'start_em':
          await debugLog('dispatch_start_em', { emId: event.emId });
          await this.handleStartEM(event);
          break;
        case 'execute_worker':
          await debugLog('dispatch_execute_worker', { emId: event.emId, workerId: event.workerId });
          await this.handleExecuteWorker(event);
          break;
        case 'create_em_pr':
          await debugLog('dispatch_create_em_pr', { emId: event.emId });
          await this.handleCreateEMPR(event);
          break;
        case 'check_completion':
          await debugLog('dispatch_check_completion');
          await this.handleCheckCompletion(event);
          break;
        case 'retry_failed':
          await debugLog('dispatch_retry_failed', { emId: event.emId, workerId: event.workerId });
          await this.handleRetryFailed(event);
          break;
        default:
          await debugLog('dispatch_unhandled', { type: event.type });
          console.log(`Unhandled event type: ${event.type}`);
      }
      
      await debugLog('handle_event_complete', { 
        type: event.type,
        phase: this.state?.phase 
      });
    } catch (error) {
      console.error('Event handling failed:', error);
      await debugLog('handle_event_error', { 
        type: event.type,
        error: (error as Error).message 
      });
      if (this.state) {
        await this.setPhase('failed');
        this.state.error = (error as Error).message;
        await saveState(this.state);
        await this.updateProgressComment((error as Error).message);
      }
      throw error;
    }
  }

  /**
   * Handle issue labeled - start new orchestration
   */
  /**
   * Handle issue labeled - analyze and dispatch EMs
   * This handler ONLY analyzes and dispatches - it does NOT execute workers
   */
  private async handleIssueLabeled(event: OrchestratorEvent): Promise<void> {
    if (!event.issueNumber) {
      throw new Error('Issue number required for issue_labeled event');
    }

    // Ensure all orchestrator labels exist in the repo
    await this.github.ensureLabelsExist();

    // Check if orchestration already in progress (idempotency check)
    const existingBranch = await findWorkBranchForIssue(event.issueNumber);
    if (existingBranch) {
      console.log(`Orchestration already in progress on branch: ${existingBranch}`);
      // Load state and check if we need to dispatch any pending EMs
      this.state = await this.loadStateFromWorkBranch(existingBranch);
      if (this.state) {
        // Dispatch any pending EMs that haven't been started
        const pendingEMs = this.state.ems.filter(em => em.status === 'pending');
        for (const em of pendingEMs) {
          await this.dispatchEvent('start_em', {
            issue_number: event.issueNumber,
            em_id: em.id
          });
        }
      }
      return;
    }

    // Get issue details
    const issue = await this.github.getIssue(event.issueNumber);
    console.log(`Starting orchestration for issue #${issue.number}: ${issue.title}`);

    // Create work branch name
    const slug = slugify(issue.title);
    const workBranch = getDirectorBranch(issue.number, slug);

    // Initialize state
    this.state = createInitialState({
      issue: { number: issue.number, title: issue.title, body: issue.body },
      repo: this.ctx.repo,
      workBranch,
      config: this.ctx.options
    });

    // Create work branch and save initial state
    await initializeState(this.state, workBranch);

    // Run analysis ONLY - this will plan EMs and dispatch them
    await this.runAnalysisAndDispatch();
  }

  /**
   * Handle issue closed - cleanup all branches and PRs
   */
  private async handleIssueClosed(event: OrchestratorEvent): Promise<void> {
    if (!event.issueNumber) {
      console.log('Issue closed event missing issue number');
      return;
    }

    console.log(`\n=== Issue #${event.issueNumber} CLOSED - Cleaning up orchestration ===`);

    // Find the work branch for this issue
    const workBranch = await findWorkBranchForIssue(event.issueNumber);
    if (!workBranch) {
      console.log('No work branch found for this issue - nothing to clean up');
      return;
    }

    // Load state to get all branches and PRs
    this.state = await this.loadStateFromWorkBranch(workBranch);
    
    // Collect all branches and PRs to clean up
    const branchesToDelete: string[] = [workBranch];
    const prsToClose: number[] = [];

    if (this.state) {
      // Collect EM and worker branches/PRs
      for (const em of this.state.ems) {
        branchesToDelete.push(em.branch);
        if (em.prNumber) prsToClose.push(em.prNumber);
        
        for (const worker of em.workers) {
          branchesToDelete.push(worker.branch);
          if (worker.prNumber) prsToClose.push(worker.prNumber);
        }
      }

      // Add final PR if exists
      if (this.state.finalPr?.number) {
        prsToClose.push(this.state.finalPr.number);
      }
    }

    // Close all open PRs
    console.log(`Closing ${prsToClose.length} PRs...`);
    for (const prNumber of prsToClose) {
      try {
        const pr = await this.github.getPullRequest(prNumber);
        if (pr.state === 'open') {
          await this.github.getOctokit().rest.pulls.update({
            owner: this.ctx.repo.owner,
            repo: this.ctx.repo.name,
            pull_number: prNumber,
            state: 'closed'
          });
          console.log(`  Closed PR #${prNumber}`);
        }
      } catch (err) {
        console.log(`  Could not close PR #${prNumber}: ${(err as Error).message}`);
      }
    }

    // Delete all branches
    console.log(`Deleting ${branchesToDelete.length} branches...`);
    for (const branch of branchesToDelete) {
      try {
        await this.github.deleteBranch(branch);
        console.log(`  Deleted branch: ${branch}`);
      } catch (err) {
        console.log(`  Could not delete branch ${branch}: ${(err as Error).message}`);
      }
    }

    // Remove orchestrator labels from the issue
    await this.github.removeOrchestratorLabels(event.issueNumber);

    console.log(`\nCleanup complete for issue #${event.issueNumber}`);
  }

  /**
   * Handle start_em event - create EM branch and dispatch workers
   */
  private async handleStartEM(event: OrchestratorEvent): Promise<void> {
    if (!event.issueNumber || event.emId === undefined) {
      throw new Error('Issue number and EM ID required for start_em event');
    }

    // Load state
    const workBranch = await findWorkBranchForIssue(event.issueNumber);
    if (!workBranch) {
      throw new Error(`No work branch found for issue #${event.issueNumber}`);
    }
    this.state = await this.loadStateFromWorkBranch(workBranch);
    if (!this.state) {
      throw new Error(`Failed to load state for issue #${event.issueNumber}`);
    }

    // Find EM
    const em = this.state.ems.find(e => e.id === event.emId);
    if (!em) {
      throw new Error(`EM-${event.emId} not found in state`);
    }

    // Idempotency check: if EM already started, skip
    if (em.status !== 'pending') {
      console.log(`EM-${em.id} already started (status: ${em.status}), skipping`);
      return;
    }

    console.log(`\n=== Starting EM-${em.id}: ${em.focusArea} ===`);

    try {
      // Create EM branch from work branch
      await this.github.createBranch(em.branch, this.state.workBranch);
      console.log(`  Created branch ${em.branch}`);

      // Break down into worker tasks using Claude
      const workerTasks = await this.breakdownEMTask(em);

      // Create worker states
      em.workers = workerTasks.map(wt => ({
        id: wt.worker_id,
        task: wt.task,
        files: wt.files,
        branch: `${em.branch}-w-${wt.worker_id}`,
        status: 'pending' as const,
        reviewsAddressed: 0
      }));

      em.status = 'workers_running';
      em.startedAt = new Date().toISOString();
      
      await saveState(this.state, `chore: EM-${em.id} assigned ${workerTasks.length} workers`);
      await this.updateProgressComment();

      // Dispatch execute_worker for EACH worker
      console.log(`  Dispatching ${em.workers.length} workers for EM-${em.id}`);
      for (const worker of em.workers) {
        await this.dispatchEvent('execute_worker', {
          issue_number: event.issueNumber,
          em_id: em.id,
          worker_id: worker.id
        });
      }

      console.log(`EM-${em.id} started - workers dispatched. Handler exiting.`);
    } catch (error) {
      console.error(`EM-${em.id} failed to start: ${(error as Error).message}`);
      em.status = 'failed';
      em.error = (error as Error).message;
      this.addErrorToHistory(`EM-${em.id} failed to start: ${(error as Error).message}`, undefined);
      await saveState(this.state);
      throw error;
    }
  }

  /**
   * Handle execute_worker event - execute worker task and create PR
   */
  private async handleExecuteWorker(event: OrchestratorEvent): Promise<void> {
    if (!event.issueNumber || event.emId === undefined || event.workerId === undefined) {
      throw new Error('Issue number, EM ID, and Worker ID required for execute_worker event');
    }

    // Load state
    const workBranch = await findWorkBranchForIssue(event.issueNumber);
    if (!workBranch) {
      throw new Error(`No work branch found for issue #${event.issueNumber}`);
    }
    this.state = await this.loadStateFromWorkBranch(workBranch);
    if (!this.state) {
      throw new Error(`Failed to load state for issue #${event.issueNumber}`);
    }

    // Find EM and worker
    const em = this.state.ems.find(e => e.id === event.emId);
    if (!em) {
      throw new Error(`EM-${event.emId} not found in state`);
    }
    const worker = em.workers.find(w => w.id === event.workerId);
    if (!worker) {
      throw new Error(`Worker-${event.workerId} not found in EM-${em.id}`);
    }

    // Idempotency check: if worker already has PR, skip
    if (worker.prNumber) {
      console.log(`Worker-${worker.id} already has PR #${worker.prNumber}, skipping`);
      return;
    }

    console.log(`\n--- Executing Worker-${worker.id}: ${worker.task.substring(0, 50)}... ---`);

    try {
      // Create worker branch from EM branch using GitHub API
      await this.github.createBranch(worker.branch, em.branch);

      worker.status = 'in_progress';
      worker.startedAt = new Date().toISOString();
      await saveState(this.state);

      // Checkout worker branch for SDK execution
      await GitOperations.checkout(worker.branch);
      await GitOperations.pull(worker.branch);

      // Execute worker task using SDK
      const prompt = this.buildWorkerPrompt(worker);
      const result = await this.sdkRunner.executeTask(prompt);

      if (!result.success) {
        worker.status = 'failed';
        worker.error = result.error;
        this.addErrorToHistory(`Worker-${worker.id} SDK execution failed: ${result.error}`, `EM-${em.id}`);
        await saveState(this.state);
        await this.updateProgressComment();
        return;
      }

      // Commit and push changes made by SDK
      const hasChanges = await GitOperations.hasUncommittedChanges();
      if (hasChanges) {
        await GitOperations.commitAndPush(`feat(worker-${worker.id}): ${worker.task.substring(0, 50)}`, worker.branch);
        console.log(`  Committed and pushed changes for Worker-${worker.id}`);
      } else {
        console.log(`  No changes to commit for Worker-${worker.id}`);
      }

      // Create PR
      const prTitle = `[EM-${em.id}/W-${worker.id}] ${worker.task.substring(0, 60)}`;
      const prBody = `## Task\n${worker.task}\n\n## Files Changed\n${worker.files.map(f => `- ${f}`).join('\n')}\n\n---\n*Automated by Claude Code Orchestrator*`;

      const pr = await this.github.createPullRequest({
        title: prTitle,
        body: prBody,
        head: worker.branch,
        base: em.branch
      });

      worker.status = 'pr_created';
      worker.prNumber = pr.number;
      worker.prUrl = pr.html_url;
      worker.completedAt = new Date().toISOString();

      // Set PR labels
      await this.github.setPRLabels(pr.number, 'cco-type-worker', 'cco-status-awaiting-review', em.id);

      await saveState(this.state, `chore: Worker-${worker.id} created PR #${pr.number}`);
      await this.syncPhaseForReviewIfReady();
      await this.updateProgressComment();

      console.log(`Worker-${worker.id} completed - PR #${pr.number} created. Handler exiting.`);
    } catch (error) {
      const errorMsg = (error as Error).message;
      
      // Handle "no commits between" error - worker produced no unique changes
      if (errorMsg.includes('No commits between') || errorMsg.includes('Validation Failed')) {
        console.log(`Worker-${worker.id} skipped: no unique commits`);
        worker.status = 'skipped';
        worker.error = 'No unique commits - worker output already in base branch';
      } else {
        console.error(`Worker-${worker.id} failed: ${errorMsg}`);
        worker.status = 'failed';
        worker.error = errorMsg;
        this.addErrorToHistory(`Worker-${worker.id} execution failed: ${errorMsg}`, `EM-${em.id}`);
      }
      
      await saveState(this.state);
      await this.syncPhaseForReviewIfReady();
      await this.updateProgressComment();
      
      // Don't throw for skipped workers - let orchestration continue
      if (worker.status === 'failed') {
        throw error;
      }
    }
  }

  /**
   * Handle create_em_pr event - create PR after all workers merged
   */
  private async handleCreateEMPR(event: OrchestratorEvent): Promise<void> {
    if (!event.issueNumber || event.emId === undefined) {
      throw new Error('Issue number and EM ID required for create_em_pr event');
    }

    // Load state
    const workBranch = await findWorkBranchForIssue(event.issueNumber);
    if (!workBranch) {
      throw new Error(`No work branch found for issue #${event.issueNumber}`);
    }
    this.state = await this.loadStateFromWorkBranch(workBranch);
    if (!this.state) {
      throw new Error(`Failed to load state for issue #${event.issueNumber}`);
    }

    const em = this.state.ems.find(e => e.id === event.emId);
    if (!em) {
      throw new Error(`EM-${event.emId} not found in state`);
    }

    // Idempotency check
    if (em.prNumber) {
      console.log(`EM-${em.id} already has PR #${em.prNumber}, skipping`);
      return;
    }

    // Check if all workers are merged
    const allWorkersMerged = em.workers.every(w => w.status === 'merged' || w.status === 'skipped');
    if (!allWorkersMerged) {
      console.log(`EM-${em.id} workers not all merged yet, skipping`);
      return;
    }

    console.log(`\n=== Creating PR for EM-${em.id} ===`);

    try {
      // Create EM PR
      const prTitle = `[EM-${em.id}] ${em.focusArea}: ${em.task.substring(0, 60)}`;
      const prBody = `## ${em.focusArea}\n\n${em.task}\n\n## Workers\n${em.workers.map(w => `- W-${w.id}: ${w.status === 'merged' ? '✅' : '⏭️'} ${w.task.substring(0, 50)}`).join('\n')}\n\n---\n*Automated by Claude Code Orchestrator*`;

      const pr = await this.github.createPullRequest({
        title: prTitle,
        body: prBody,
        head: em.branch,
        base: this.state.workBranch
      });

      em.status = 'pr_created';
      em.prNumber = pr.number;
      em.prUrl = pr.html_url;

      await this.github.setPRLabels(pr.number, 'cco-type-em', 'cco-status-awaiting-review', em.id);

      await saveState(this.state, `chore: EM-${em.id} created PR #${pr.number}`);
      await this.updateProgressComment();

      console.log(`EM-${em.id} PR #${pr.number} created. Handler exiting.`);
    } catch (error) {
      console.error(`Failed to create EM-${em.id} PR: ${(error as Error).message}`);
      em.status = 'failed';
      em.error = (error as Error).message;
      this.addErrorToHistory(`EM-${em.id} PR creation failed: ${(error as Error).message}`, undefined);
      await saveState(this.state);
      throw error;
    }
  }

  /**
   * Handle check_completion event - check if all EMs done and create final PR
   */
  private async handleCheckCompletion(event: OrchestratorEvent): Promise<void> {
    if (!event.issueNumber) {
      throw new Error('Issue number required for check_completion event');
    }

    // Load state
    const workBranch = await findWorkBranchForIssue(event.issueNumber);
    if (!workBranch) {
      throw new Error(`No work branch found for issue #${event.issueNumber}`);
    }
    this.state = await this.loadStateFromWorkBranch(workBranch);
    if (!this.state) {
      throw new Error(`Failed to load state for issue #${event.issueNumber}`);
    }

    // Check if all EMs are merged
    const allEMsMerged = this.state.ems.every(em => em.status === 'merged' || em.status === 'skipped');
    if (!allEMsMerged) {
      console.log('Not all EMs merged yet, skipping final PR creation');
      return;
    }

    // Check if final PR already exists
    if (this.state.finalPr?.number) {
      console.log(`Final PR #${this.state.finalPr.number} already exists, skipping`);
      return;
    }

    console.log('\n=== All EMs merged - Creating final PR ===');

    try {
      await this.createFinalPR();
    } catch (error) {
      console.error(`Failed to create final PR: ${(error as Error).message}`);
      this.addErrorToHistory(`Final PR creation failed: ${(error as Error).message}`, undefined);
      await saveState(this.state);
      throw error;
    }
  }

  /**
   * Handle retry_failed event - retry a failed worker or EM
   */
  private async handleRetryFailed(event: OrchestratorEvent): Promise<void> {
    if (!event.issueNumber) {
      throw new Error('Issue number required for retry_failed event');
    }

    // Load state
    const workBranch = await findWorkBranchForIssue(event.issueNumber);
    if (!workBranch) {
      throw new Error(`No work branch found for issue #${event.issueNumber}`);
    }
    this.state = await this.loadStateFromWorkBranch(workBranch);
    if (!this.state) {
      throw new Error(`Failed to load state for issue #${event.issueNumber}`);
    }

    if (event.workerId !== undefined && event.emId !== undefined) {
      // Retry worker
      const em = this.state.ems.find(e => e.id === event.emId);
      const worker = em?.workers.find(w => w.id === event.workerId);
      if (worker && worker.status === 'failed') {
        worker.status = 'pending';
        worker.error = undefined;
        await saveState(this.state);
        await this.dispatchEvent('execute_worker', {
          issue_number: event.issueNumber,
          em_id: event.emId,
          worker_id: event.workerId,
          retry_count: (event.retryCount || 0) + 1
        });
      }
    } else if (event.emId !== undefined) {
      // Retry EM
      const em = this.state.ems.find(e => e.id === event.emId);
      if (em && em.status === 'failed') {
        em.status = 'pending';
        em.error = undefined;
        await saveState(this.state);
        await this.dispatchEvent('start_em', {
          issue_number: event.issueNumber,
          em_id: event.emId,
          retry_count: (event.retryCount || 0) + 1
        });
      }
    }
  }

  /**
   * Run director analysis to break down issue into EM tasks
   */
  /**
   * Run analysis and dispatch EMs (event-driven version)
   * This ONLY analyzes and dispatches - does NOT execute workers
   */
  private async runAnalysisAndDispatch(): Promise<void> {
    if (!this.state) throw new Error('No state');

    console.log('\n=== Phase: Director Analysis ===');
    await this.setPhase('analyzing');
    await saveState(this.state);
    await this.updateProgressComment();

    const { maxEms, maxWorkersPerEm } = this.state.config;

    const prompt = `You are a technical director analyzing a GitHub issue to break it down into tasks.

**Issue #${this.state.issue.number}: ${this.state.issue.title}**

${this.state.issue.body}

**IMPORTANT - READ FIRST:**
If this is a web application (Next.js, React, Vue, Angular, Svelte, etc.) with multiple features:
- You MUST create MULTIPLE EMs (6-10 total)
- Do NOT put everything in one EM or a few EMs
- Break down by architectural layers: Setup, Data, Auth, API, UI Components, Pages, Features
- USE ALL available ${maxEms} EMs for complex apps
- This is MANDATORY - parallelization is critical for timely delivery

**Understanding the Issue:**
- This issue may contain test failures in various formats (Rust cargo, Jest, pytest, etc.)
- Test names with timestamps like \`2026-01-20T13:03:40.5487877Z\` are Rust cargo test output
- Look for patterns: failures sections, test names, module paths (e.g., \`solver::evaluate::tests::test_name\`)
- If multiple test suites are failing (e.g., "Solver", "Binder", "Checker"), group related failures
- Extract the core problem from the test failures - what actually needs to be fixed?

**For Test Failure Issues:**
- Group failing tests by the module/component they belong to
- One EM per major component (e.g., "Solver tests", "Binder tests", "Checker tests")
- Each EM should fix tests for their assigned module
- Focus on the root cause - multiple tests may fail for the same reason
- Estimated workers should be proportional to: (number of failing tests in group) / 10

**For Web App Projects (Next.js, React, Vue, etc.):**
- These are COMPLEX tasks requiring MANY EMs with multiple workers each
- Break down into: Setup, Data Layer, Authentication, API Routes, UI Components, Pages, Real-time/Features, Testing
- Example breakdown for a full-stack app:
  - EM-0: Project Setup (gitignore, package.json, tsconfig, .github/workflows/ci.yml, shared types)
  - EM-1: Data Layer (DB schema, models, migrations, repositories)
  - EM-2: Authentication (auth provider, login/signup, middleware, session management)
  - EM-3: API Routes (endpoint handlers, validation, business logic)
  - EM-4: UI Components (reusable components, forms, layouts)
  - EM-5: Pages/Views (route handlers, page components, data fetching)
  - EM-6: Additional Features (real-time, file uploads, notifications, etc.)
- USE ALL ${maxEms} EMs for substantial web apps - parallelization is critical!

**For CI/CD Requirements:**
- EVERY new project MUST include a CI workflow file (.github/workflows/ci.yml or similar)
- The CI workflow MUST include: lint, typecheck, test, and build jobs
- This is CRITICAL for auto-merge to work - PRs need passing checks to merge
- Project Setup EM MUST create the CI workflow file as one of its first tasks

**Your task:**
1. First, determine if this project needs initial setup (gitignore, package.json, tsconfig, CI workflow, etc.)
2. Break this issue down into EM (Engineering Manager) tasks. Each EM focuses on a distinct area.
3. Provide a brief summary for the PR description.

**CRITICAL: FILE OWNERSHIP (most important rule):**
- **EACH EM MUST OWN COMPLETELY SEPARATE FILES/DIRECTORIES**
- NO two EMs can create or modify the same file - this causes merge conflicts!
- Assign EXPLICIT directory ownership to each EM:
  - EM-1: "owns src/models/, src/lib/storage.ts"
  - EM-2: "owns src/components/, src/pages/"
  - EM-3: "owns src/api/, src/middleware/"
- Files that multiple EMs need (like types) should be created by the FIRST EM and only IMPORTED by others
- Include "files_owned" array in each EM's output to make ownership clear

**Important Guidelines:**
- If this is a new project, include a "Project Setup" EM (id: 0) that runs FIRST
- Project Setup EM should create ALL setup files: .gitignore, package.json, tsconfig.json, .github/workflows/ci.yml, AND shared types
- NO other EM should create setup files - they assume setup is done
- Other EMs IMPORT from setup-created files, never modify them

**Team Sizing - USE ALL AVAILABLE CAPACITY for complex tasks:**
- You have up to ${maxEms} EMs available (not counting setup)
- Each EM can have up to ${maxWorkersPerEm} Workers
- For SIMPLE tasks (1-2 features): Use 1-2 EMs with 1-2 workers each
- For MEDIUM tasks (3-5 features): Use 3-5 EMs with 2-3 workers each
- For COMPLEX tasks (web apps, many features, multiple layers): USE ALL ${maxEms} EMs with ${maxWorkersPerEm} workers each
- More workers = faster completion but ensure non-overlapping work
- When in doubt, USE MORE workers - parallelization speeds up delivery

**Output ONLY a JSON object (no other text):**
{
  "needs_setup": true,
  "summary": "Brief summary of the implementation plan for PR description",
  "ems": [
    {
      "em_id": 0,
      "task": "Set up project foundation with .gitignore, package.json, tsconfig.json, and shared types",
      "focus_area": "Project Setup",
      "files_owned": [".gitignore", "package.json", "tsconfig.json", "src/types.ts"],
      "estimated_workers": 1,
      "must_complete_first": true
    },
    {
      "em_id": 1,
      "task": "Description of what this EM should accomplish",
      "focus_area": "e.g., Core Logic, UI, Testing",
      "files_owned": ["src/models/", "src/lib/"],
      "estimated_workers": 2,
      "must_complete_first": false
    }
  ]
}`;

    const sessionId = generateSessionId('director', this.state.issue.number);
    const result = await this.claude.runTask(prompt, sessionId);

    if (!result.success) {
      throw new Error(`Director analysis failed: ${result.stderr}`);
    }

    const analysis = extractJson(result.stdout) as {
      needs_setup: boolean;
      summary: string;
      ems: Array<{
        em_id: number;
        task: string;
        focus_area: string;
        estimated_workers: number;
        must_complete_first?: boolean;
      }>;
    };

    if (!analysis.ems || !Array.isArray(analysis.ems) || analysis.ems.length === 0) {
      throw new Error('Director returned no EM tasks');
    }

    // Store summary for PR description
    this.state.analysisSummary = analysis.summary;

    // Check if we need project setup first
    const setupEM = analysis.ems.find(em => em.must_complete_first || em.focus_area === 'Project Setup');
    const otherEMs = analysis.ems.filter(em => !em.must_complete_first && em.focus_area !== 'Project Setup');

    if (setupEM) {
      // Run setup phase first
      this.state.projectSetup = { completed: false };
      await this.setPhase('project_setup');
      
      // Create setup EM state
      this.state.ems = [{
        id: 0,
        task: setupEM.task,
        focusArea: 'Project Setup',
        branch: `cco/issue-${this.state.issue.number}-setup`,
        status: 'pending' as const,
        workers: [],
        reviewsAddressed: 0
      }];

      // Store other EMs in state for later (after setup completes)
      this.state.pendingEMs = otherEMs.slice(0, maxEms).map((em, idx) => ({
        id: idx + 1,
        task: em.task,
        focusArea: em.focus_area,
        branch: `cco/issue-${this.state!.issue.number}-em-${idx + 1}`,
        status: 'pending' as const,
        workers: [],
        reviewsAddressed: 0
      }));

      console.log(`Project setup needed. ${this.state.pendingEMs.length} EMs queued after setup.`);
      await saveState(this.state, `chore: director planned project setup and ${this.state.pendingEMs.length} EMs`);
      await this.updateProgressComment();

      // Dispatch setup EM
      await this.dispatchEvent('start_em', {
        issue_number: this.state.issue.number,
        em_id: 0
      });
    } else {
      // No setup needed, proceed normally
      this.state.ems = otherEMs.slice(0, maxEms).map((em, idx) => ({
        id: idx + 1,
        task: em.task,
        focusArea: em.focus_area,
        branch: `cco/issue-${this.state!.issue.number}-em-${idx + 1}`,
        status: 'pending' as const,
        workers: [],
        reviewsAddressed: 0
      }));

      await this.setPhase('em_assignment');
      await saveState(this.state, `chore: director assigned ${this.state.ems.length} EMs`);
      await this.updateProgressComment();

      // Dispatch ALL EMs in parallel
      console.log(`\n=== Dispatching ${this.state.ems.length} EMs ===`);
      for (const em of this.state.ems) {
        await this.dispatchEvent('start_em', {
          issue_number: this.state.issue.number,
          em_id: em.id
        });
      }
    }

    console.log('Analysis complete - EMs dispatched. Handler exiting.');
  }

  /**
   * Legacy runAnalysis - kept for backward compatibility during migration
   * @deprecated Use runAnalysisAndDispatch instead
   */
  private async runAnalysis(): Promise<void> {
    if (!this.state) throw new Error('No state');

    console.log('\n=== Phase: Director Analysis ===');
    await this.setPhase('analyzing');
    await saveState(this.state);
    await this.updateProgressComment();

    const { maxEms, maxWorkersPerEm } = this.state.config;

    const prompt = `You are a technical director analyzing a GitHub issue to break it down into tasks.

**Issue #${this.state.issue.number}: ${this.state.issue.title}**

${this.state.issue.body}

**IMPORTANT - READ FIRST:**
If this is a web application (Next.js, React, Vue, Angular, Svelte, etc.) with multiple features:
- You MUST create MULTIPLE EMs (6-10 total)
- Do NOT put everything in one EM or a few EMs
- Break down by architectural layers: Setup, Data, Auth, API, UI Components, Pages, Features
- USE ALL available ${maxEms} EMs for complex apps
- This is MANDATORY - parallelization is critical for timely delivery

**Understanding the Issue:**
- This issue may contain test failures in various formats (Rust cargo, Jest, pytest, etc.)
- Test names with timestamps like \`2026-01-20T13:03:40.5487877Z\` are Rust cargo test output
- Look for patterns: failures sections, test names, module paths (e.g., \`solver::evaluate::tests::test_name\`)
- If multiple test suites are failing (e.g., "Solver", "Binder", "Checker"), group related failures
- Extract the core problem from the test failures - what actually needs to be fixed?

**For Test Failure Issues:**
- Group failing tests by the module/component they belong to
- One EM per major component (e.g., "Solver tests", "Binder tests", "Checker tests")
- Each EM should fix tests for their assigned module
- Focus on the root cause - multiple tests may fail for the same reason
- Estimated workers should be proportional to: (number of failing tests in group) / 10

**For Web App Projects (Next.js, React, Vue, etc.):**
- These are COMPLEX tasks requiring MANY EMs with multiple workers each
- Break down into: Setup, Data Layer, Authentication, API Routes, UI Components, Pages, Real-time/Features, Testing
- Example breakdown for a full-stack app:
  - EM-0: Project Setup (gitignore, package.json, tsconfig, .github/workflows/ci.yml, shared types)
  - EM-1: Data Layer (DB schema, models, migrations, repositories)
  - EM-2: Authentication (auth provider, login/signup, middleware, session management)
  - EM-3: API Routes (endpoint handlers, validation, business logic)
  - EM-4: UI Components (reusable components, forms, layouts)
  - EM-5: Pages/Views (route handlers, page components, data fetching)
  - EM-6: Additional Features (real-time, file uploads, notifications, etc.)
- USE ALL ${maxEms} EMs for substantial web apps - parallelization is critical!

**For CI/CD Requirements:**
- EVERY new project MUST include a CI workflow file (.github/workflows/ci.yml or similar)
- The CI workflow MUST include: lint, typecheck, test, and build jobs
- This is CRITICAL for auto-merge to work - PRs need passing checks to merge
- Project Setup EM MUST create the CI workflow file as one of its first tasks

**Your task:**
1. First, determine if this project needs initial setup (gitignore, package.json, tsconfig, CI workflow, etc.)
2. Break this issue down into EM (Engineering Manager) tasks. Each EM focuses on a distinct area.
3. Provide a brief summary for the PR description.

**CRITICAL: FILE OWNERSHIP (most important rule):**
- **EACH EM MUST OWN COMPLETELY SEPARATE FILES/DIRECTORIES**
- NO two EMs can create or modify the same file - this causes merge conflicts!
- Assign EXPLICIT directory ownership to each EM:
  - EM-1: "owns src/models/, src/lib/storage.ts"
  - EM-2: "owns src/components/, src/pages/"
  - EM-3: "owns src/api/, src/middleware/"
- Files that multiple EMs need (like types) should be created by the FIRST EM and only IMPORTED by others
- Include "files_owned" array in each EM's output to make ownership clear

**Important Guidelines:**
- If this is a new project, include a "Project Setup" EM (id: 0) that runs FIRST
- Project Setup EM should create ALL setup files: .gitignore, package.json, tsconfig.json, .github/workflows/ci.yml, AND shared types
- NO other EM should create setup files - they assume setup is done
- Other EMs IMPORT from setup-created files, never modify them

**Team Sizing - USE ALL AVAILABLE CAPACITY for complex tasks:**
- You have up to ${maxEms} EMs available (not counting setup)
- Each EM can have up to ${maxWorkersPerEm} Workers
- For SIMPLE tasks (1-2 features): Use 1-2 EMs with 1-2 workers each
- For MEDIUM tasks (3-5 features): Use 3-5 EMs with 2-3 workers each
- For COMPLEX tasks (web apps, many features, multiple layers): USE ALL ${maxEms} EMs with ${maxWorkersPerEm} workers each
- More workers = faster completion but ensure non-overlapping work
- When in doubt, USE MORE workers - parallelization speeds up delivery

**Output ONLY a JSON object (no other text):**
{
  "needs_setup": true,
  "summary": "Brief summary of the implementation plan for PR description",
  "ems": [
    {
      "em_id": 0,
      "task": "Set up project foundation with .gitignore, package.json, tsconfig.json, and shared types",
      "focus_area": "Project Setup",
      "files_owned": [".gitignore", "package.json", "tsconfig.json", "src/types.ts"],
      "estimated_workers": 1,
      "must_complete_first": true
    },
    {
      "em_id": 1,
      "task": "Description of what this EM should accomplish",
      "focus_area": "e.g., Core Logic, UI, Testing",
      "files_owned": ["src/models/", "src/lib/"],
      "estimated_workers": 2,
      "must_complete_first": false
    }
  ]
}`;

    const sessionId = generateSessionId('director', this.state.issue.number);
    const result = await this.claude.runTask(prompt, sessionId);

    if (!result.success) {
      throw new Error(`Director analysis failed: ${result.stderr}`);
    }

    const analysis = extractJson(result.stdout) as {
      needs_setup: boolean;
      summary: string;
      ems: Array<{
        em_id: number;
        task: string;
        focus_area: string;
        estimated_workers: number;
        must_complete_first?: boolean;
      }>;
    };

    if (!analysis.ems || !Array.isArray(analysis.ems) || analysis.ems.length === 0) {
      throw new Error('Director returned no EM tasks');
    }

    // Store summary for PR description
    this.state.analysisSummary = analysis.summary;

    // Check if we need project setup first
    const setupEM = analysis.ems.find(em => em.must_complete_first || em.focus_area === 'Project Setup');
    const otherEMs = analysis.ems.filter(em => !em.must_complete_first && em.focus_area !== 'Project Setup');

    if (setupEM) {
      // Run setup phase first
      this.state.projectSetup = { completed: false };
      await this.setPhase('project_setup');
      await this.updateProgressComment();

      // Create setup EM state
      this.state.ems = [{
        id: 0,
        task: setupEM.task,
        focusArea: 'Project Setup',
        branch: `cco/issue-${this.state.issue.number}-setup`,
        status: 'pending' as const,
        workers: [],
        reviewsAddressed: 0,
        startedAt: new Date().toISOString()
      }];

      // Store other EMs in state for later (after setup completes)
      this.state.pendingEMs = otherEMs.slice(0, maxEms).map((em, idx) => ({
        id: idx + 1,
        task: em.task,
        focusArea: em.focus_area,
        branch: `cco/issue-${this.state!.issue.number}-em-${idx + 1}`,
        status: 'pending' as const,
        workers: [],
        reviewsAddressed: 0
      }));

      console.log(`Project setup needed. ${this.state.pendingEMs.length} EMs queued after setup.`);
      await saveState(this.state, `chore: director starting project setup first (${this.state.pendingEMs.length} EMs pending)`);

      // Start setup EM
      await this.startNextEM();
    } else {
      // No setup needed, proceed normally
      this.state.ems = otherEMs.slice(0, maxEms).map((em, idx) => ({
        id: idx + 1,
        task: em.task,
        focusArea: em.focus_area,
        branch: `cco/issue-${this.state!.issue.number}-em-${idx + 1}`,
        status: 'pending' as const,
        workers: [],
        reviewsAddressed: 0,
        startedAt: new Date().toISOString()
      }));

      await this.setPhase('em_assignment');
      await saveState(this.state, `chore: director assigned ${this.state.ems.length} EMs`);
      await this.updateProgressComment();

      // Start ALL EMs in parallel
      await this.startAllPendingEMs();
    }
  }

  /**
   * Start ALL pending EMs in parallel
   * This is the key to parallel execution - all EMs work simultaneously
   */
  private async startAllPendingEMs(): Promise<void> {
    if (!this.state) throw new Error('No state');

    const pendingEMs = this.state.ems.filter(em => em.status === 'pending');
    if (pendingEMs.length === 0) {
      // All EMs have started, check if we need to create final PR
      await this.checkFinalMerge();
      return;
    }

    console.log(`\n=== Starting ${pendingEMs.length} EMs in PARALLEL ===`);

    // Start all pending EMs in parallel
    await Promise.all(pendingEMs.map(em => this.startSingleEM(em)));
  }

  /**
   * Start a single EM (called in parallel for multiple EMs)
   */
  private async startSingleEM(em: EMState): Promise<void> {
    if (!this.state) throw new Error('No state');

    console.log(`\n=== Starting EM-${em.id}: ${em.focusArea} ===`);

    try {
      // Create EM branch from work branch
      await this.github.createBranch(em.branch, this.state.workBranch);
      console.log(`  Created branch ${em.branch}`);

      // Break down into worker tasks
      const workerTasks = await this.breakdownEMTask(em);

      // Create worker states
      em.workers = workerTasks.map(wt => ({
        id: wt.worker_id,
        task: wt.task,
        files: wt.files,
        branch: `${em.branch}-w-${wt.worker_id}`,
        status: 'pending' as const,
        reviewsAddressed: 0
      }));

      em.status = 'workers_running';
      em.startedAt = new Date().toISOString();
      
      await saveState(this.state, `chore: EM-${em.id} assigned ${workerTasks.length} workers`);
      await this.updateProgressComment();

      // Start all workers for this EM in parallel
      await this.startAllWorkersForEM(em);
    } catch (error) {
      console.error(`EM-${em.id} failed to start: ${(error as Error).message}`);
      em.status = 'failed';
      em.error = (error as Error).message;
      addErrorToHistory(this.state, `EM-${em.id} failed to start: ${(error as Error).message}`, undefined);
    }
  }

  /**
   * Start the next pending EM (legacy - for setup EM which must run first)
   */
  private async startNextEM(): Promise<void> {
    if (!this.state) throw new Error('No state');

    const pendingEM = this.state.ems.find(em => em.status === 'pending');
    if (!pendingEM) {
      // All EMs have started, check if we need to create final PR
      await this.checkFinalMerge();
      return;
    }

    console.log(`\n=== Starting EM-${pendingEM.id}: ${pendingEM.focusArea} ===`);

    // Create EM branch
    await GitOperations.checkout(this.state.workBranch);
    await GitOperations.createBranch(pendingEM.branch, this.state.workBranch);
    await GitOperations.push(pendingEM.branch);

    // Break down into worker tasks
    const workerTasks = await this.breakdownEMTask(pendingEM);

    // Create worker states
    pendingEM.workers = workerTasks.map(wt => ({
      id: wt.worker_id,
      task: wt.task,
      files: wt.files,
      branch: `${pendingEM.branch}-w-${wt.worker_id}`,
      status: 'pending' as const,
      reviewsAddressed: 0
    }));

    pendingEM.status = 'workers_running';
    await this.setPhase('worker_execution');
    await saveState(this.state, `chore: EM-${pendingEM.id} assigned ${workerTasks.length} workers`);
    await this.updateProgressComment();

    // Start first worker
    await this.startNextWorker(pendingEM);
  }

  /**
   * Break down an EM task into worker tasks
   */
  private async breakdownEMTask(em: EMState): Promise<Array<{
    worker_id: number;
    task: string;
    files: string[];
  }>> {
    if (!this.state) throw new Error('No state');

    const { maxWorkersPerEm } = this.state.config;

    const prompt = `You are an Engineering Manager breaking down a task into worker assignments.

**Your EM Task:** ${em.task}
**Focus Area:** ${em.focusArea}

**Context - Original Issue:**
${this.state.issue.body}

**CRITICAL: FILE OWNERSHIP (Workers MUST NOT overlap):**
- You can use up to ${maxWorkersPerEm} workers - USE MORE for complex tasks!
- **EACH WORKER MUST CREATE/MODIFY COMPLETELY DIFFERENT FILES** - NO overlap!
- Overlapping files cause MERGE CONFLICTS that CRASH the entire orchestration!
- Specify EXACTLY which files each worker should create or modify
- Tasks should be concrete (e.g., "Create Calculator class in src/calculator.ts")
- If a task requires multiple related files, assign them ALL to the SAME worker
- Workers can IMPORT from each other's files but NEVER MODIFY them

**Worker Sizing:**
- Simple EM task: 1-2 workers
- Medium EM task: 2-3 workers
- Complex EM task: USE ALL ${maxWorkersPerEm} workers
- More workers = parallel execution = faster delivery

**Example of GOOD division (no file overlap):**
- Worker-1: Creates src/types.ts (types only)
- Worker-2: Creates src/storage.ts (imports from types.ts but doesn't modify it)  
- Worker-3: Creates src/notes.ts (imports from types.ts and storage.ts)

**Example of BAD division (will cause conflicts):**
- Worker-1: src/types.ts
- Worker-2: src/types.ts, src/storage.ts  <- FATAL! Overlaps with Worker-1

**File Assignment Rules:**
- Each file appears in EXACTLY ONE worker's files array
- Shared utilities/types should be in one worker, imported by others
- Test files belong to the worker who creates the source file

**Output ONLY a JSON array (no other text):**
[
  {
    "worker_id": 1,
    "task": "Specific task with EXACT files this worker will create/modify",
    "files": ["path/to/file1.ts"]
  }
]`;

    const sessionId = generateSessionId('em', this.state.issue.number, em.id);
    const result = await this.claude.runTask(prompt, sessionId);

    if (!result.success) {
      console.error(`EM-${em.id} breakdown failed: ${result.stderr}`);
      return [{ worker_id: 1, task: em.task, files: [] }];
    }

    try {
      const tasks = extractJson(result.stdout) as Array<{
        worker_id: number;
        task: string;
        files: string[];
      }>;
      return Array.isArray(tasks) && tasks.length > 0 
        ? tasks.slice(0, maxWorkersPerEm) 
        : [{ worker_id: 1, task: em.task, files: [] }];
    } catch {
      return [{ worker_id: 1, task: em.task, files: [] }];
    }
  }

  /**
   * Start ALL workers for an EM in parallel
   */
  private async startAllWorkersForEM(em: EMState): Promise<void> {
    if (!this.state) throw new Error('No state');

    const pendingWorkers = em.workers.filter(w => w.status === 'pending');
    if (pendingWorkers.length === 0) {
      await this.createEMPullRequest(em);
      return;
    }

    console.log(`  Starting ${pendingWorkers.length} workers in parallel for EM-${em.id}`);

    // Start all workers in parallel
    await Promise.all(pendingWorkers.map(worker => this.executeSingleWorker(em, worker)));

    // After all workers complete, create EM PR
    await this.createEMPullRequest(em);
  }

  /**
   * Execute a single worker task (called in parallel)
   */
  private async executeSingleWorker(em: EMState, worker: typeof em.workers[0]): Promise<void> {
    if (!this.state) throw new Error('No state');

    console.log(`\n--- Starting Worker-${worker.id}: ${worker.task.substring(0, 50)}... ---`);

    try {
      // Create worker branch from EM branch using GitHub API (no local checkout needed)
      await this.github.createBranch(worker.branch, em.branch);

      worker.status = 'in_progress';
      worker.startedAt = new Date().toISOString();

      // Execute worker task using SDK (works in any directory)
      const prompt = this.buildWorkerPrompt(worker);
      const result = await this.sdkRunner.executeTask(prompt);

      if (!result.success) {
        worker.status = 'failed';
        worker.error = result.error;
        addErrorToHistory(this.state, `Worker-${worker.id} SDK execution failed: ${result.error}`, `EM-${em.id}`);
        console.error(`Worker-${worker.id} failed: ${result.error}`);
        return;
      }

      // The SDK runner commits changes - we need to push to the worker branch
      // For parallel execution, we use GitHub API to create PR directly
      
      // Create worker PR
      const pr = await this.github.createPullRequest({
        title: `[EM-${em.id}/W-${worker.id}] ${worker.task.substring(0, 60)}`,
        body: `## Worker Implementation\n\n**Task:** ${worker.task}\n\n---\n*Automated by Claude Code Orchestrator*`,
        head: worker.branch,
        base: em.branch
      });

      // Add labels to PR
      await this.github.setPRLabels(
        pr.number,
        TYPE_LABELS.WORKER,
        STATUS_LABELS.AWAITING_REVIEW,
        em.id
      );

      worker.status = 'pr_created';
      worker.prNumber = pr.number;
      worker.prUrl = pr.html_url;
      worker.completedAt = new Date().toISOString();

      console.log(`Worker-${worker.id} PR created: ${pr.html_url}`);

    } catch (error) {
      const errorMsg = (error as Error).message;
      
      if (errorMsg.includes('No commits between') || errorMsg.includes('Validation Failed')) {
        console.log(`Worker-${worker.id} skipped: no unique commits`);
        worker.status = 'skipped';
        worker.error = 'No unique commits';
      } else {
        console.error(`Worker-${worker.id} failed: ${errorMsg}`);
        worker.status = 'failed';
        worker.error = errorMsg;
        addErrorToHistory(this.state, `Worker-${worker.id} failed: ${errorMsg}`, `EM-${em.id}`);
      }
    }

    await this.updateProgressComment();
  }

  /**
   * Build the prompt for a worker task
   */
  private buildWorkerPrompt(worker: { task: string; files?: string[] }): string {
    return `⚠️ **WARNING: YOU MUST WRITE COMPLETE, PRODUCTION-READY CODE** ⚠️

Many workers have failed by only creating skeleton files. YOU WILL BE EVALUATED ON:
1. Writing FULL implementation code, not just types or interfaces
2. Creating WORKING features with actual logic
3. Including proper error handling, validation, and edge cases
4. Writing PRODUCTION-QUALITY code, not placeholder stubs

**Your Task:** ${worker.task}

**Files to work with:** ${worker.files?.length ? worker.files.join(', ') : 'Create whatever files are needed'}

**Context - Original Issue:**
${this.state?.issue.body || ''}

**CRITICAL Instructions:**
1. Create files directly in the current directory (NOT in a subdirectory)
2. NEVER run "npm install" - only create config files
3. Implement the task completely with clean, production-ready code
4. Include necessary imports and exports
5. **WRITE COMPLETE IMPLEMENTATION CODE** - Not just skeleton or stub files!
6. Include actual logic, error handling, validation, and production-quality code
7. For UI components: Include full component code with props, state, and styling
8. For API routes: Include full request handling, validation, and responses
9. For pages/views: Include complete page logic, not just empty shells
10. For utilities/libraries: Include full implementation, not just type definitions

**DO NOT create:**
- node_modules/ directory
- Any SUMMARY.md or documentation files
- README.md (unless specifically asked)
- Empty skeleton files with no actual implementation
- Files with just "export const xyz = () => TODO" or similar placeholders
- Type-only files with no actual logic implementation

**Example of GOOD implementation:**
- A React component with full JSX, props, hooks, event handlers, and styling
- An API route with validation, error handling, database queries, and responses
- A utility function with full logic, edge case handling, and proper types

**Example of BAD implementation (DO NOT DO THIS):**
- A component with just "export const Component = () => <div>TODO</div>;"
- An API route with just "export async function GET() { return Response.json({}); }"
- Type-only files with no actual logic
- Files with placeholder comments like "// TODO: implement this"

Implement this task now with COMPLETE, PRODUCTION-READY code. Every file must have actual working code.`;
  }

  /**
   * Start the next pending worker for an EM (legacy sequential mode)
   * Errors are caught and logged, allowing orchestration to continue
   */
  private async startNextWorker(em: EMState): Promise<void> {
    if (!this.state) throw new Error('No state');

    const pendingWorker = getNextPendingWorker(em);
    if (!pendingWorker) {
      // All workers done, create EM PR
      await this.createEMPullRequest(em);
      return;
    }

    console.log(`\n--- Starting Worker-${pendingWorker.id}: ${pendingWorker.task.substring(0, 50)}... ---`);

    try {
      // Create worker branch
      await GitOperations.checkout(em.branch);
      await GitOperations.createBranch(pendingWorker.branch, em.branch);

      pendingWorker.status = 'in_progress';
      pendingWorker.startedAt = new Date().toISOString();
      await saveState(this.state);

      // Execute worker task
      const prompt = `⚠️ **WARNING: YOU MUST WRITE COMPLETE, PRODUCTION-READY CODE** ⚠️

Many workers have failed by only creating skeleton files. YOU WILL BE EVALUATED ON:
1. Writing FULL implementation code, not just types or interfaces
2. Creating WORKING features with actual logic
3. Including proper error handling, validation, and edge cases
4. Writing PRODUCTION-QUALITY code, not placeholder stubs

**Your Task:** ${pendingWorker.task}

**Files to work with:** ${pendingWorker.files?.length > 0 ? pendingWorker.files.join(', ') : 'Create whatever files are needed'}

**Context - Original Issue:**
${this.state.issue.body}

**CRITICAL Instructions:**
1. Create files directly in the current directory (NOT in a subdirectory)
2. NEVER run "npm install" - only create config files
3. Implement the task completely with clean, production-ready code
4. Include necessary imports and exports
5. **WRITE COMPLETE IMPLEMENTATION CODE** - Not just skeleton or stub files!
6. Include actual logic, error handling, validation, and production-quality code
7. For UI components: Include full component code with props, state, and styling
8. For API routes: Include full request handling, validation, and responses
9. For pages/views: Include complete page logic, not just empty shells
10. For utilities/libraries: Include full implementation, not just type definitions

**ABSOLUTE RULES:**
- Create files in the ROOT directory, NOT inside any subdirectory
- Do NOT create or commit node_modules under any circumstances
- If creating a Next.js project, do NOT use "npx create-next-app" - manually create the files
- Write the actual file contents, don't run scaffolding commands

**DO NOT create:**
- node_modules/ directory
- Any SUMMARY.md or documentation files
- README.md (unless specifically asked)
- Empty skeleton files with no actual implementation
- Files with just "export const xyz = () => TODO" or similar placeholders
- Type-only files with no actual logic implementation

**Example of GOOD implementation:**
- A React component with full JSX, props, hooks, event handlers, and styling
- An API route with validation, error handling, database queries, and responses
- A utility function with full logic, edge case handling, and proper types

**Example of BAD implementation (DO NOT DO THIS):**
- A component with just "export const Component = () => <div>TODO</div>;"
- An API route with just "export async function GET() { return Response.json({}); }"
- Type-only files with no actual logic
- Files with placeholder comments like "// TODO: implement this"

**If this is a setup task, create files in THIS ORDER:**
1. .gitignore FIRST (must include: node_modules, .next, .env*, dist)
2. package.json with dependencies
3. tsconfig.json for TypeScript
4. .github/workflows/ci.yml with lint, typecheck, test, and build jobs (CRITICAL for auto-merge!)
5. Other config files as needed

Implement this task now with COMPLETE, PRODUCTION-READY code. Every file must have actual working code.`;

      const result = await this.sdkRunner.executeTask(prompt);

      if (!result.success) {
        // Mark worker as failed but continue with others
        pendingWorker.status = 'failed';
        pendingWorker.error = result.error;
        addErrorToHistory(this.state, `Worker-${pendingWorker.id} SDK execution failed: ${result.error}`, `EM-${em.id}`);
        await saveState(this.state);
        await this.updateProgressComment();
        console.error(`Worker-${pendingWorker.id} failed: ${result.error} - continuing with next worker`);
        // Continue with next worker instead of throwing
        await this.startNextWorker(em);
        return;
      }

      // Commit and push
      const hasChanges = await GitOperations.hasUncommittedChanges();
      if (hasChanges) {
        await GitOperations.commitAndPush(
          `feat(em-${em.id}/worker-${pendingWorker.id}): ${pendingWorker.task.substring(0, 50)}`,
          pendingWorker.branch
        );
      } else {
        // No changes - worker didn't create anything
        console.log(`Worker-${pendingWorker.id} produced no changes`);
        await GitOperations.push(pendingWorker.branch);
      }

      // Try to create worker PR
      try {
        const pr = await this.github.createPullRequest({
          title: `[EM-${em.id}/W-${pendingWorker.id}] ${pendingWorker.task.substring(0, 60)}`,
          body: `## Worker Implementation\n\n**Task:** ${pendingWorker.task}\n\n---\n*Automated by Claude Code Orchestrator*`,
          head: pendingWorker.branch,
          base: em.branch
        });

        // Add labels to PR (type + status + em association)
        await this.github.setPRLabels(
          pr.number,
          TYPE_LABELS.WORKER,
          STATUS_LABELS.AWAITING_REVIEW,
          em.id
        );

        pendingWorker.status = 'pr_created';
        pendingWorker.prNumber = pr.number;
        pendingWorker.prUrl = pr.html_url;
        pendingWorker.completedAt = new Date().toISOString();

        await this.setPhase('worker_review');
        await saveState(this.state, `chore: Worker-${pendingWorker.id} PR created (#${pr.number})`);
        await this.updateProgressComment();

        console.log(`Worker-${pendingWorker.id} PR created: ${pr.html_url}`);
      } catch (prError) {
        const errorMsg = (prError as Error).message;
        // Handle "no commits between" error - worker produced no unique changes
        if (errorMsg.includes('No commits between') || errorMsg.includes('Validation Failed')) {
          console.log(`Worker-${pendingWorker.id} skipped: no unique commits (${errorMsg})`);
          pendingWorker.status = 'skipped';
          pendingWorker.error = 'No unique commits - worker output already in base branch';
          addErrorToHistory(this.state, `Worker-${pendingWorker.id} skipped: ${errorMsg}`, `EM-${em.id}`);
          await saveState(this.state);
          await this.updateProgressComment();
        } else {
          // Other PR creation errors - mark as failed but continue
          console.error(`Worker-${pendingWorker.id} PR creation failed: ${errorMsg}`);
          pendingWorker.status = 'failed';
          pendingWorker.error = errorMsg;
          addErrorToHistory(this.state, `Worker-${pendingWorker.id} PR creation failed: ${errorMsg}`, `EM-${em.id}`);
          await saveState(this.state);
          await this.updateProgressComment();
        }
      }

      // Continue with next worker
      await this.startNextWorker(em);
      
    } catch (error) {
      // Catch-all for unexpected errors - mark worker as failed and continue
      const errorMsg = (error as Error).message;
      console.error(`Worker-${pendingWorker.id} unexpected error: ${errorMsg}`);
      pendingWorker.status = 'failed';
      pendingWorker.error = errorMsg;
      addErrorToHistory(this.state, `Worker-${pendingWorker.id} unexpected error: ${errorMsg}`, `EM-${em.id}`);
      await saveState(this.state);
      await this.updateProgressComment();
      
      // Continue with next worker instead of crashing
      await this.startNextWorker(em);
    }
  }

  /**
   * Wait for reviews before merging a PR
   * Polls for reviews to appear, then addresses any comments before allowing merge
   */
  private async waitForReviewsBeforeMerge(prNumber: number, prCreatedAt?: string): Promise<void> {
    const waitMinutes = this.state?.config.reviewWaitMinutes || 5;
    const maxWaitSeconds = waitMinutes * 60;
    const pollIntervalSeconds = 15;
    
    // Calculate initial wait based on PR creation time
    let initialWait = maxWaitSeconds;
    if (prCreatedAt) {
      const createdTime = new Date(prCreatedAt).getTime();
      const elapsed = (Date.now() - createdTime) / 1000;
      initialWait = Math.max(0, maxWaitSeconds - elapsed);
    }

    console.log(`  Waiting for reviews on PR #${prNumber} (max ${Math.ceil(initialWait / 60)}m)...`);

    // Poll for reviews to appear
    const startTime = Date.now();
    let reviews: Awaited<ReturnType<typeof this.github.getPullRequestReviews>> = [];
    let comments: Awaited<ReturnType<typeof this.github.getPullRequestComments>> = [];
    
    while ((Date.now() - startTime) / 1000 < initialWait) {
      // Check current review state
      reviews = await this.github.getPullRequestReviews(prNumber);
      comments = await this.github.getPullRequestComments(prNumber);
      
      // If we have reviews or comments, Copilot/reviewers have responded
      if (reviews.length > 0 || comments.length > 0) {
        console.log(`  PR #${prNumber}: Found ${reviews.length} reviews, ${comments.length} comments`);
        break;
      }
      
      // Wait before polling again
      const remaining = initialWait - (Date.now() - startTime) / 1000;
      if (remaining > pollIntervalSeconds) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalSeconds * 1000));
      } else if (remaining > 0) {
        await new Promise(resolve => setTimeout(resolve, remaining * 1000));
        break;
      }
    }

    // Final check for reviews and comments
    reviews = await this.github.getPullRequestReviews(prNumber);
    comments = await this.github.getPullRequestComments(prNumber);

    // Check for CHANGES_REQUESTED - must address before merge
    const hasChangesRequested = reviews.some(r => r.state === 'CHANGES_REQUESTED');
    if (hasChangesRequested) {
      console.log(`  PR #${prNumber} has CHANGES_REQUESTED - addressing feedback...`);
      throw new Error('PR has changes requested - needs addressing');
    }

    // If there are inline review comments, we need to address them
    if (comments.length > 0) {
      console.log(`  PR #${prNumber} has ${comments.length} review comments - addressing before merge...`);
      
      // Get the PR to find its branch
      const pr = await this.github.getPullRequest(prNumber);
      
      // Address the review comments
      await this.addressReviewComments(prNumber, pr.head.ref, comments);
      
      // After addressing, wait a moment for GitHub to process
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Re-check for any new comments that might have appeared
      const newComments = await this.github.getPullRequestComments(prNumber);
      const unresolvedComments = newComments.filter(c => 
        !comments.some(old => old.id === c.id)
      );
      
      if (unresolvedComments.length > 0) {
        console.log(`  PR #${prNumber}: ${unresolvedComments.length} new comments appeared after addressing`);
      }
    }

    console.log(`  PR #${prNumber} ready for merge`);
  }

  /**
   * Address review comments on a PR before merging
   */
  private async addressReviewComments(
    prNumber: number, 
    branch: string, 
    comments: Awaited<ReturnType<typeof this.github.getPullRequestComments>>
  ): Promise<void> {
    if (comments.length === 0) return;

    // Filter to actionable comments (not from bots responding to themselves)
    const actionableComments = comments.filter(c => 
      !c.body.includes('Fixed!') && 
      !c.body.includes('_Automated response_') &&
      c.body.length > 10
    );

    if (actionableComments.length === 0) {
      console.log(`    No actionable comments to address`);
      return;
    }

    console.log(`    Addressing ${actionableComments.length} review comments...`);

    // Checkout the branch
    await GitOperations.checkout(branch);

    // Process comments
    await this.processInlineComments(prNumber, actionableComments, branch);

    // Commit and push any changes
    const hasChanges = await GitOperations.hasUncommittedChanges();
    if (hasChanges) {
      await GitOperations.commitAndPush('fix: address review comments before merge', branch);
      console.log(`    Committed fixes for review comments`);
    }
  }

  /**
   * Create EM PR after all workers are done
   */
  private async createEMPullRequest(em: EMState): Promise<void> {
    if (!this.state) throw new Error('No state');

    // First merge all worker PRs
    console.log(`\nMerging worker PRs for EM-${em.id}...`);
    for (const worker of em.workers) {
      if (worker.prNumber && (worker.status === 'pr_created' || worker.status === 'approved')) {
        // Wait for reviews before merging
        try {
          await this.waitForReviewsBeforeMerge(worker.prNumber, worker.completedAt);
        } catch (err) {
          console.log(`  Skipping merge of Worker-${worker.id} PR: ${(err as Error).message}`);
          addErrorToHistory(this.state, `Worker-${worker.id} review wait failed: ${(err as Error).message}`, `EM-${em.id}`);
          continue;
        }
        
        let result = await this.github.mergePullRequest(worker.prNumber);
        
        // If base branch was modified, try to update and retry
        if (!result.merged && result.error?.includes('Base branch modified')) {
          console.log(`  Updating Worker-${worker.id} PR #${worker.prNumber} branch...`);
          const updated = await this.github.updatePullRequestBranch(worker.prNumber);
          if (updated) {
            // Wait a moment for GitHub to process the update
            await new Promise(resolve => setTimeout(resolve, 2000));
            result = await this.github.mergePullRequest(worker.prNumber);
          }
        }
        
        if (result.merged) {
          worker.status = 'merged';
          await this.github.setStatusLabel(worker.prNumber, STATUS_LABELS.MERGED);
          console.log(`  Merged Worker-${worker.id} PR #${worker.prNumber}${result.alreadyMerged ? ' (was already merged)' : ''}`);
        } else {
          const reason = result.error || 'Unknown';
          console.warn(`  Could not merge Worker-${worker.id} PR #${worker.prNumber}: ${reason}`);
          worker.status = 'failed';
          worker.error = reason;
          const failLabel = reason.includes('conflict') ? STATUS_LABELS.CONFLICTS : STATUS_LABELS.FAILED;
          await this.github.setStatusLabel(worker.prNumber, failLabel);
          addErrorToHistory(this.state, `Worker-${worker.id} merge failed: ${reason}`, `EM-${em.id}`);
        }
      }
    }

    // Pull latest EM branch
    await GitOperations.checkout(em.branch);
    await GitOperations.pull(em.branch);

    // Check if this EM has any successful workers (merged or approved)
    if (!hasSuccessfulWorkers(em)) {
      const reason = 'No workers merged - all skipped/failed';
      console.warn(`EM-${em.id}: ${reason}. Marking as skipped.`);
      em.status = 'skipped';
      em.error = reason;
      addErrorToHistory(this.state, `EM-${em.id} skipped: ${reason}`, `WorkersStatus: ${em.workers.map(w => `W${w.id}:${w.status}`).join(', ')}`);
      await saveState(this.state);
      await this.updateProgressComment();
      // Continue to next EM
      await this.startNextEM();
      return;
    }

    const mergedWorkers = em.workers.filter(w => w.status === 'merged');

    // Create EM PR to work branch
    try {
      const isSetupEM = em.focusArea === 'Project Setup';
      const pr = await this.github.createPullRequest({
        title: `[EM-${em.id}] ${em.focusArea}: ${em.task.substring(0, 50)}`,
        body: `## EM-${em.id}: ${em.focusArea}\n\n**Task:** ${em.task}\n\n**Workers:** ${em.workers.length} (${mergedWorkers.length} merged)\n\n---\n*Automated by Claude Code Orchestrator*`,
        head: em.branch,
        base: this.state.workBranch
      });

      // Add labels to PR (type + status)
      await this.github.setPRLabels(
        pr.number,
        isSetupEM ? TYPE_LABELS.SETUP : TYPE_LABELS.EM,
        STATUS_LABELS.AWAITING_REVIEW
      );

      em.status = 'pr_created';
      em.prNumber = pr.number;
      em.prUrl = pr.html_url;
      console.log(`EM-${em.id} PR created: ${pr.html_url}`);
    } catch (error) {
      const errMsg = (error as Error).message;
      if (errMsg.includes('No commits between') || errMsg.includes('Validation Failed')) {
        console.warn(`EM-${em.id}: No unique commits to PR (branch same as base). Marking as skipped.`);
        em.status = 'skipped';
        em.error = 'Branch identical to base - no unique commits';
        addErrorToHistory(this.state, `EM-${em.id} skipped: ${errMsg}`, 'No diff from work branch');
      } else {
        // Other PR errors - mark EM as failed but continue
        console.error(`EM-${em.id} PR creation failed: ${errMsg}`);
        em.status = 'failed';
        em.error = errMsg;
        addErrorToHistory(this.state, `EM-${em.id} PR creation failed: ${errMsg}`, undefined);
      }
    }

    await this.setPhase('em_review');
    await saveState(this.state, `chore: EM-${em.id} PR processed`);
    await this.updateProgressComment();

    // Start next EM if any
    await this.startNextEM();
  }

  /**
   * Check if ready for final merge
   */
  private async checkFinalMerge(): Promise<void> {
    if (!this.state) throw new Error('No state');

    // Check if all current EMs have PRs created, merged, or skipped
    const allEMsReady = this.state.ems.every(em => 
      em.status === 'pr_created' || 
      em.status === 'approved' || 
      em.status === 'merged' ||
      em.status === 'skipped' ||
      em.status === 'failed'
    );

    if (!allEMsReady) {
      console.log('Not all EMs are ready for final merge yet');
      return;
    }

    // If there are pending EMs (from setup phase), add them now and continue
    if (this.state.pendingEMs && this.state.pendingEMs.length > 0) {
      console.log(`\n=== Adding ${this.state.pendingEMs.length} pending EMs after setup ===`);
      
      // Merge setup EM first (wait for reviews)
      for (const em of this.state.ems) {
        if (em.prNumber && (em.status === 'pr_created' || em.status === 'approved')) {
          try {
            await this.waitForReviewsBeforeMerge(em.prNumber, em.completedAt);
          } catch (err) {
            console.log(`  Skipping review wait for EM-${em.id}: ${(err as Error).message}`);
          }
          const result = await this.github.mergePullRequest(em.prNumber);
          if (result.merged) {
            em.status = 'merged';
            console.log(`Merged setup EM-${em.id} PR #${em.prNumber}`);
          } else {
            addErrorToHistory(this.state, `Setup EM-${em.id} merge failed: ${result.error}`, undefined);
          }
        }
      }
      
      // Add pending EMs to the active list
      this.state.ems.push(...this.state.pendingEMs);
      this.state.pendingEMs = [];
      await this.setPhase('em_assignment');
      
      await saveState(this.state, `chore: setup complete, starting ${this.state.ems.length - 1} EMs in PARALLEL`);
      await this.updateProgressComment();
      
      // Start ALL pending EMs in parallel (the key to parallel execution!)
      console.log(`\n=== Starting ${this.state.ems.filter(e => e.status === 'pending').length} EMs in PARALLEL ===`);
      await this.startAllPendingEMs();
      return;
    }

    // Merge all EM PRs (wait for reviews on each)
    console.log('\n=== Merging EM PRs ===');
    for (const em of this.state.ems) {
      if (em.prNumber && (em.status === 'pr_created' || em.status === 'approved')) {
        // Wait for reviews before merging
        try {
          await this.waitForReviewsBeforeMerge(em.prNumber, em.completedAt);
        } catch (err) {
          console.log(`  Skipping review wait for EM-${em.id}: ${(err as Error).message}`);
        }
        
        let result = await this.github.mergePullRequest(em.prNumber);
        
        // If base branch was modified, try to update and retry
        if (!result.merged && result.error?.includes('Base branch modified')) {
          console.log(`  Updating EM-${em.id} PR #${em.prNumber} branch...`);
          const updated = await this.github.updatePullRequestBranch(em.prNumber);
          if (updated) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            result = await this.github.mergePullRequest(em.prNumber);
          }
        }
        
        if (result.merged) {
          em.status = 'merged';
          await this.github.setStatusLabel(em.prNumber, STATUS_LABELS.MERGED);
          console.log(`Merged EM-${em.id} PR #${em.prNumber}${result.alreadyMerged ? ' (was already merged)' : ''}`);
        } else {
          const reason = result.error || 'Unknown';
          console.warn(`Could not merge EM-${em.id} PR #${em.prNumber}: ${reason}`);
          em.status = 'failed';
          em.error = reason;
          const failLabel = reason.includes('conflict') ? STATUS_LABELS.CONFLICTS : STATUS_LABELS.FAILED;
          await this.github.setStatusLabel(em.prNumber, failLabel);
          addErrorToHistory(this.state, `EM-${em.id} merge failed: ${reason}`, `PR #${em.prNumber}`);
        }
      }
    }

    // Check if we have at least one successfully merged EM
    const mergedEMs = this.state.ems.filter(em => em.status === 'merged');
    if (mergedEMs.length === 0) {
      const reason = 'No EMs merged - all skipped or failed';
      console.error(reason);
      addErrorToHistory(this.state, reason, `EMs status: ${this.state.ems.map(e => `EM${e.id}:${e.status}`).join(', ')}`);
      await this.setPhase('failed');
      this.state.error = reason;
      await saveState(this.state);
      await this.updateProgressComment(reason);
      return;
    }

    // Pull latest work branch
    await GitOperations.checkout(this.state.workBranch);
    await GitOperations.pull(this.state.workBranch);

    await this.setPhase('final_merge');
    await saveState(this.state);
    await this.updateProgressComment();

    // Create final PR to main
    await this.createFinalPR();
  }

  /**
   * Create the final PR to main
   */
  private async createFinalPR(): Promise<void> {
    if (!this.state) throw new Error('No state');

    console.log('\n=== Creating Final PR ===');

    // Build comprehensive PR body with analysis summary
    const summarySection = this.state.analysisSummary 
      ? `### Implementation Summary\n${this.state.analysisSummary}\n\n`
      : '';

    const body = `## Automated Implementation for Issue #${this.state.issue.number}

**Issue:** ${this.state.issue.title}

${summarySection}### Orchestration Details
- **EMs:** ${this.state.ems.length}
- **Total Workers:** ${this.state.ems.reduce((sum, em) => sum + em.workers.length, 0)}

### Task Breakdown
${this.state.ems.map(em => `
#### EM-${em.id}: ${em.focusArea}
${em.task}
- Workers: ${em.workers.length}
${em.workers.map(w => `  - Worker-${w.id}: ${w.task.substring(0, 60)}...`).join('\n')}
`).join('\n')}

---
Closes #${this.state.issue.number}

*Automated by Claude Code Orchestrator*`;

    // Create the PR first
    const pr = await this.github.createPullRequest({
      title: `feat: ${this.state.issue.title}`,
      body,
      head: this.state.workBranch,
      base: this.state.baseBranch
    });

    // Add labels to final PR (type + status)
    await this.github.setPRLabels(
      pr.number,
      TYPE_LABELS.FINAL,
      STATUS_LABELS.AWAITING_REVIEW
    );

    this.state.finalPr = { number: pr.number, url: pr.html_url, reviewsAddressed: 0 };
    await this.setPhase('final_review');  // Stay in final_review to handle reviews
    
    // Save state - keep state file to enable review handling
    // State file will be removed when PR is merged (in handlePRMerged)
    await saveState(this.state, 'chore: final PR created');
    await this.updateProgressComment();

    console.log(`Final PR created: ${pr.html_url}`);
    console.log('Waiting for reviews. State preserved for review handling.');
  }

  /**
   * Handle PR merged event
   */
  private async handlePRMerged(event: OrchestratorEvent): Promise<void> {
    if (!event.prNumber || !event.branch) {
      console.error('PR merged event: missing prNumber or branch');
      return;
    }

    // Find work branch from PR branch name
    const workBranch = await this.findWorkBranchFromPRBranch(event.branch);
    if (!workBranch) {
      console.error(`PR merged event: could not find work branch for PR branch ${event.branch}, skipping merge processing`);
      return;
    }

    // Load state
    this.state = await this.loadStateFromWorkBranch(workBranch);
    if (!this.state) {
      console.error(`PR merged event: could not load state from work branch ${workBranch}, skipping merge processing`);
      return;
    }

    // Check if this is the final PR being merged
    if (this.state.finalPr?.number === event.prNumber) {
      console.log('Final PR merged! Marking orchestration complete.');
      await this.setPhase('complete');
      await this.github.setStatusLabel(event.prNumber, STATUS_LABELS.MERGED);
      
      // Remove state file from work branch
      try {
        await execa('git', ['rm', '-f', '.orchestrator/state.json']);
        await execa('git', ['commit', '-m', 'chore: remove orchestrator state file']);
        await GitOperations.push();
      } catch (err) {
        console.log('State file cleanup:', (err as Error).message);
      }
      
      await this.updateProgressComment();
      return;
    }

    // Update state based on which PR was merged
    let mergedEM: EMState | null = null;
    for (const em of this.state.ems) {
      // Check if it's a worker PR
      for (const worker of em.workers) {
        if (worker.prNumber === event.prNumber) {
          worker.status = 'merged';
          console.log(`Worker-${worker.id} PR merged`);
          mergedEM = em; // Track which EM this worker belongs to
        }
      }

      // Check if it's an EM PR
      if (em.prNumber === event.prNumber) {
        em.status = 'merged';
        console.log(`EM-${em.id} PR merged`);
      }
    }

    await saveState(this.state);

    // Proactively check for reviews on other worker PRs before proceeding
    await this.checkAndAddressReviews();

    // Event-driven: Dispatch next steps instead of continuing inline
    if (mergedEM) {
      // Check if all workers for this EM are merged
      const allWorkersMerged = mergedEM.workers.every(w => w.status === 'merged' || w.status === 'skipped');
      if (allWorkersMerged && !mergedEM.prNumber) {
        // Dispatch create_em_pr
        console.log(`All workers merged for EM-${mergedEM.id}, dispatching create_em_pr`);
        await this.dispatchEvent('create_em_pr', {
          issue_number: this.state.issue.number,
          em_id: mergedEM.id
        });
      }
    }

    // Check if all EMs are merged - dispatch check_completion
    const allEMsMerged = this.state.ems.every(em => em.status === 'merged' || em.status === 'skipped');
    if (allEMsMerged && !this.state.finalPr?.number) {
      console.log('All EMs merged, dispatching check_completion');
      await this.dispatchEvent('check_completion', {
        issue_number: this.state.issue.number
      });
    }

    await this.updateProgressComment();
  }

  /**
   * Find the state node (worker/em) that owns a PR so we can store dedupe metadata.
   */
  private getOrInitReviewTrackingForPR(prNumber: number): {
    addressedReviewCommentIds: number[];
    addressedIssueCommentIds: number[];
  } | null {
    if (!this.state) return null;

    for (const em of this.state.ems) {
      for (const worker of em.workers) {
        if (worker.prNumber === prNumber) {
          worker.addressedReviewCommentIds = worker.addressedReviewCommentIds || [];
          worker.addressedIssueCommentIds = worker.addressedIssueCommentIds || [];
          return {
            addressedReviewCommentIds: worker.addressedReviewCommentIds,
            addressedIssueCommentIds: worker.addressedIssueCommentIds
          };
        }
      }

      if (em.prNumber === prNumber) {
        em.addressedReviewCommentIds = em.addressedReviewCommentIds || [];
        em.addressedIssueCommentIds = em.addressedIssueCommentIds || [];
        return {
          addressedReviewCommentIds: em.addressedReviewCommentIds,
          addressedIssueCommentIds: em.addressedIssueCommentIds
        };
      }
    }

    return null;
  }

  /**
   * Return the set of unaddressed ROOT inline review comments on a PR.
   * A root comment is considered addressed if:
   * - it has a reply containing ORCHESTRATOR_REVIEW_MARKER, OR
   * - it is present in addressedReviewCommentIds in state.
   */
  private async getUnaddressedRootReviewCommentIds(prNumber: number): Promise<number[]> {
    const tracking = this.getOrInitReviewTrackingForPR(prNumber);
    const addressed = new Set<number>(tracking?.addressedReviewCommentIds || []);

    const comments = await this.github.getPullRequestComments(prNumber);

    const repliesByRootId = new Map<number, Array<typeof comments[number]>>();
    for (const c of comments) {
      if (c.inReplyToId) {
        const list = repliesByRootId.get(c.inReplyToId) || [];
        list.push(c);
        repliesByRootId.set(c.inReplyToId, list);
      }
    }

    const rootComments = comments.filter(c => !c.inReplyToId);
    const unaddressed: number[] = [];

    for (const root of rootComments) {
      if (root.user === 'github-actions[bot]') continue;
      if (root.body.includes(ORCHESTRATOR_REVIEW_MARKER)) continue;
      if (addressed.has(root.id)) continue;

      const replies = repliesByRootId.get(root.id) || [];
      const hasAddressedReply = replies.some(r => r.body.includes(ORCHESTRATOR_REVIEW_MARKER));
      if (hasAddressedReply) {
        // Backfill state so future runs can skip even without scanning replies
        tracking?.addressedReviewCommentIds.push(root.id);
        addressed.add(root.id);
        continue;
      }

      unaddressed.push(root.id);
    }

    return unaddressed;
  }

  /**
   * Check if a PR has a Copilot review and is ready to merge
   * Copilot COMMENTED reviews are considered ready to merge (no approval needed)
   */
  private async hasCopilotCommentedReview(prNumber: number): Promise<boolean> {
    const reviews = await this.github.getPullRequestReviews(prNumber);
    return reviews.some(r =>
      r.state.toLowerCase() === 'commented' &&
      r.user?.toLowerCase().includes('copilot')
    );
  }

  /**
   * Determine whether a PR is ready to merge based on review state and unaddressed comments.
   * We intentionally do NOT require \"APPROVED\" to support Copilot COMMENTED reviews.
   * For Copilot COMMENTED reviews, we don't require all review comments to be addressed.
   */
  private async isPRReadyToMerge(prNumber: number): Promise<boolean> {
    const reviews = await this.github.getPullRequestReviews(prNumber);
    if (reviews.some(r => r.state === 'CHANGES_REQUESTED')) {
      return false;
    }

    // Special handling for Copilot COMMENTED reviews:
    // If there's a Copilot COMMENTED review and no CHANGES_REQUESTED, the PR is ready to merge
    // We don't require addressing Copilot's overview/commentary comments
    const hasCopilotCommented = await this.hasCopilotCommentedReview(prNumber);
    if (hasCopilotCommented) {
      console.log(`PR #${prNumber} has Copilot COMMENTED review - considering ready to merge`);
      return true;
    }

    const unaddressed = await this.getUnaddressedRootReviewCommentIds(prNumber);
    return unaddressed.length === 0;
  }

  /**
   * Attempt to merge a PR if it is review-clean.
   */
  private async maybeAutoMergePR(prNumber: number): Promise<void> {
    try {
      console.log(`Checking if PR #${prNumber} is ready to merge...`);
      const ready = await this.isPRReadyToMerge(prNumber);
      if (!ready) {
        console.log(`PR #${prNumber} is not ready to merge (still waiting for reviews)`);
        return;
      }

      console.log(`PR #${prNumber} is review-clean, marking as ready to merge`);
      await this.github.setStatusLabel(prNumber, STATUS_LABELS.READY_TO_MERGE);

      // Try merge (may fail due to checks/permissions/branch protection)
      console.log(`Attempting to merge PR #${prNumber}...`);
      const result = await this.github.mergePullRequest(prNumber);
      if (result.merged) {
        console.log(`PR #${prNumber} merged successfully!`);
        await this.github.setStatusLabel(prNumber, STATUS_LABELS.MERGED);
      } else if (result.error) {
        console.warn(`PR #${prNumber} not merged: ${result.error}`);
        // Keep as awaiting review so future events can retry
        await this.github.setStatusLabel(prNumber, STATUS_LABELS.AWAITING_REVIEW);
      } else if (result.alreadyMerged) {
        console.log(`PR #${prNumber} was already merged`);
      }
    } catch (err) {
      console.error(`Auto-merge attempt failed for PR #${prNumber}: ${(err as Error).message}`);
      console.error(err);
      // Do not throw from auto-merge; it's best-effort
    }
  }

  /**
   * Sync global phase for review/merge work once execution has produced PRs.
   * In practice, project_setup should transition to worker_review once all setup workers are done.
   */
  private async syncPhaseForReviewIfReady(): Promise<void> {
    if (!this.state) return;

    const anyWorkerRunning = this.state.ems.some(em =>
      em.workers.some(w => w.status === 'pending' || w.status === 'in_progress')
    );
    const anyWorkerAwaitingReview = this.state.ems.some(em =>
      em.workers.some(w => w.status === 'pr_created' || w.status === 'changes_requested' || w.status === 'approved')
    );

    if (!anyWorkerRunning && anyWorkerAwaitingReview && this.state.phase !== 'worker_review') {
      await this.setPhase('worker_review');
      await saveState(this.state, 'chore: transition to worker_review');
      await this.updateProgressComment();
    }
  }

  /**
   * Proactively check for reviews on all PRs and address them
   */
  private async checkAndAddressReviews(): Promise<void> {
    if (!this.state) return;

    for (const em of this.state.ems) {
      // Check worker PRs
      for (const worker of em.workers) {
        if (worker.prNumber && worker.status === 'pr_created') {
          try {
            const reviews = await this.github.getPullRequestReviews(worker.prNumber);
            const hasChangesRequested = reviews.some(r => r.state === 'CHANGES_REQUESTED');
            const unaddressed = await this.getUnaddressedRootReviewCommentIds(worker.prNumber);

            if (hasChangesRequested || unaddressed.length > 0) {
              console.log(`Worker-${worker.id} PR #${worker.prNumber} has reviews - addressing`);
              await this.github.setStatusLabel(worker.prNumber, STATUS_LABELS.ADDRESSING_FEEDBACK);
              try {
                await this.addressReview(worker.branch, worker.prNumber, '');
                worker.reviewsAddressed++;
              } finally {
                await this.github.setStatusLabel(worker.prNumber, STATUS_LABELS.AWAITING_REVIEW);
              }

              await saveState(this.state);
              await this.updateProgressComment();
            }

            // If review is clean, try merging
            await this.maybeAutoMergePR(worker.prNumber);
          } catch (err) {
            console.log(`Could not check reviews for Worker-${worker.id} PR: ${(err as Error).message}`);
          }
        }
      }

      // Check EM PRs
      if (em.prNumber && em.status === 'pr_created') {
        try {
          const reviews = await this.github.getPullRequestReviews(em.prNumber);
          const hasChangesRequested = reviews.some(r => r.state === 'CHANGES_REQUESTED');
          const unaddressed = await this.getUnaddressedRootReviewCommentIds(em.prNumber);

          if (hasChangesRequested || unaddressed.length > 0) {
            console.log(`EM-${em.id} PR #${em.prNumber} has reviews - addressing`);
            await this.github.setStatusLabel(em.prNumber, STATUS_LABELS.ADDRESSING_FEEDBACK);
            try {
              await this.addressReview(em.branch, em.prNumber, '');
              em.reviewsAddressed++;
            } finally {
              await this.github.setStatusLabel(em.prNumber, STATUS_LABELS.AWAITING_REVIEW);
            }
            await saveState(this.state);
            await this.updateProgressComment();
          }

          await this.maybeAutoMergePR(em.prNumber);
        } catch (err) {
          console.log(`Could not check reviews for EM-${em.id} PR: ${(err as Error).message}`);
        }
      }
    }

    await this.syncPhaseForReviewIfReady();
  }

  /**
   * Handle PR review event
   */
  private async handlePRReview(event: OrchestratorEvent): Promise<void> {
    if (!event.prNumber || !event.branch) {
      console.log('PR review event: missing prNumber or branch');
      return;
    }

    // Fetch review details from API if not provided (for Copilot reviews)
    let reviewState = event.reviewState;
    let reviewBody = event.reviewBody || '';
    let isCopilotCommented = false;

    if (!reviewState || !reviewBody) {
      try {
        const reviews = await this.github.getPullRequestReviews(event.prNumber);
        const latestReview = reviews[reviews.length - 1];
        if (latestReview) {
          reviewState = latestReview.state.toLowerCase() as 'approved' | 'changes_requested' | 'commented';
          reviewBody = latestReview.body || '';
          // Check if this is a Copilot COMMENTED review
          isCopilotCommented = reviewState === 'commented' &&
            latestReview.user.toLowerCase().includes('copilot');
        }
      } catch (err) {
        console.log(`Could not fetch review details: ${(err as Error).message}`);
      }
    }

    // Only act on changes_requested or commented (for Copilot reviews with comments)
    if (reviewState !== 'changes_requested' && reviewState !== 'commented') {
      console.log(`PR review event: state is ${reviewState}, no action needed`);
      return;
    }

    // For Copilot COMMENTED reviews, skip addressing and go straight to auto-merge
    if (isCopilotCommented) {
      console.log(`PR review event: Copilot COMMENTED review detected - attempting auto-merge`);
      // Find work branch and load state
      const workBranch = await this.findWorkBranchFromPRBranch(event.branch);
      if (!workBranch) {
        console.error(`PR review event: could not find work branch for PR branch ${event.branch}`);
        return;
      }
      this.state = await this.loadStateFromWorkBranch(workBranch);
      if (!this.state) {
        console.error(`PR review event: could not load state from work branch ${workBranch}`);
        return;
      }
      // Try to auto-merge immediately for Copilot COMMENTED reviews
      await this.maybeAutoMergePR(event.prNumber);
      return;
    }

    // For 'commented' reviews, check if there's actual actionable feedback
    // Also check for inline comments
    const hasInlineComments = (await this.github.getPullRequestComments(event.prNumber)).length > 0;
    if (reviewState === 'commented' && (!reviewBody || reviewBody.length < 20) && !hasInlineComments) {
      console.log('PR review event: commented but no substantial feedback');
      return;
    }

    // Find work branch
    const workBranch = await this.findWorkBranchFromPRBranch(event.branch);
    if (!workBranch) {
      console.error(`PR review event: could not find work branch for PR branch ${event.branch}, skipping review processing`);
      return;
    }

    // Load state
    this.state = await this.loadStateFromWorkBranch(workBranch);
    if (!this.state) {
      console.error(`PR review event: could not load state from work branch ${workBranch}, skipping review processing`);
      return;
    }

    // Check if this is the final PR
    if (this.state.finalPr?.number === event.prNumber) {
      console.log('Addressing review on final PR');
      await this.addressFinalPRReview(event.prNumber, reviewBody);
      return;
    }

    // Find the worker or EM that owns this PR
    for (const em of this.state.ems) {
      for (const worker of em.workers) {
        if (worker.prNumber === event.prNumber) {
          console.log(`Addressing review on Worker-${worker.id} PR`);
          // Set status to addressing feedback while working
          await this.github.setStatusLabel(event.prNumber, STATUS_LABELS.ADDRESSING_FEEDBACK);
          try {
            await this.addressReview(worker.branch, event.prNumber, reviewBody);
          worker.reviewsAddressed++;
          worker.status = 'pr_created';
          } finally {
            // Set back to awaiting review after addressing
            await this.github.setStatusLabel(event.prNumber, STATUS_LABELS.AWAITING_REVIEW);
          }

          await saveState(this.state);
          await this.syncPhaseForReviewIfReady();
          await this.updateProgressComment();

          // If review is now clean, try merging
          await this.maybeAutoMergePR(event.prNumber);

          // Also proactively handle reviews on other PRs for this issue
          await this.checkAndAddressReviews();
          return;
        }
      }

      if (em.prNumber === event.prNumber) {
        console.log(`Addressing review on EM-${em.id} PR`);
        // Set status to addressing feedback while working
        await this.github.setStatusLabel(event.prNumber, STATUS_LABELS.ADDRESSING_FEEDBACK);
        try {
          await this.addressReview(em.branch, event.prNumber, reviewBody);
        em.reviewsAddressed++;
        em.status = 'pr_created';
        } finally {
          // Set back to awaiting review after addressing
          await this.github.setStatusLabel(event.prNumber, STATUS_LABELS.AWAITING_REVIEW);
        }
        await saveState(this.state);
        await this.syncPhaseForReviewIfReady();
        await this.updateProgressComment();

        await this.maybeAutoMergePR(event.prNumber);

        await this.checkAndAddressReviews();
        return;
      }
    }
  }

  /**
   * Address review feedback on a branch (worker/EM PRs)
   */
  private async addressReview(branch: string, prNumber: number, reviewBody: string): Promise<void> {
    await GitOperations.checkout(branch);

    // Get inline review comments (code comments)
    const reviewComments = await this.github.getPullRequestComments(prNumber);
    
    // Get general PR comments (issue-style comments)
    const prComments = await this.github.getPullRequestIssueComments(prNumber);

    // Resolve which state node owns this PR so we can dedupe review handling
    let addressedReviewCommentIds: number[] = [];
    let addressedIssueCommentIds: number[] = [];
    if (this.state) {
      for (const em of this.state.ems) {
        for (const worker of em.workers) {
          if (worker.prNumber === prNumber) {
            worker.addressedReviewCommentIds = worker.addressedReviewCommentIds || [];
            worker.addressedIssueCommentIds = worker.addressedIssueCommentIds || [];
            addressedReviewCommentIds = worker.addressedReviewCommentIds;
            addressedIssueCommentIds = worker.addressedIssueCommentIds;
          }
        }
        if (em.prNumber === prNumber) {
          em.addressedReviewCommentIds = em.addressedReviewCommentIds || [];
          em.addressedIssueCommentIds = em.addressedIssueCommentIds || [];
          addressedReviewCommentIds = em.addressedReviewCommentIds;
          addressedIssueCommentIds = em.addressedIssueCommentIds;
        }
      }
    }

    const addressedReviewSet = new Set<number>(addressedReviewCommentIds);
    const addressedIssueSet = new Set<number>(addressedIssueCommentIds);

    const markReviewAddressed = (id: number) => {
      if (addressedReviewSet.has(id)) return;
      addressedReviewSet.add(id);
      addressedReviewCommentIds.push(id);
    };

    const markIssueAddressed = (id: number) => {
      if (addressedIssueSet.has(id)) return;
      addressedIssueSet.add(id);
      addressedIssueCommentIds.push(id);
    };
    
    // Process inline comments individually
    if (reviewComments.length > 0) {
      console.log(`Processing ${reviewComments.length} inline code comments...`);
      await this.processInlineComments(prNumber, reviewComments, branch, {
        isAlreadyAddressed: (rootId) => addressedReviewSet.has(rootId),
        markAddressed: markReviewAddressed
      });
    }

    // Process general PR comments
    const actionableComments = prComments.filter(c => 
      c.user !== 'github-actions[bot]' && 
      !c.body.includes('Automated by Claude') &&
      !c.body.includes('_Automated response_') &&
      !c.body.includes(ORCHESTRATOR_REVIEW_MARKER) &&
      !addressedIssueSet.has(c.id) &&
      c.body.length > 10
    );
    
    if (actionableComments.length > 0) {
      console.log(`Processing ${actionableComments.length} general PR comments...`);
      await this.processGeneralPRComments(prNumber, actionableComments, branch, {
        isAlreadyAddressed: (commentId) => addressedIssueSet.has(commentId),
        markAddressed: markIssueAddressed
      });
    }

    // If there's also a review body, address it
    if (reviewBody && reviewBody.trim().length > 20) {
      console.log('Addressing review body feedback...');
      await this.addressGeneralReviewFeedback(branch, reviewBody);
    }

    // Commit and push any remaining changes
    const hasChanges = await GitOperations.hasUncommittedChanges();
    if (hasChanges) {
      await GitOperations.commitAndPush('fix: address review feedback', branch);
      console.log('Review feedback addressed and pushed');
    } else {
      console.log('All review comments handled');
    }
  }

  /**
   * Process general PR comments (not inline code comments)
   */
  private async processGeneralPRComments(
    prNumber: number,
    comments: Array<{ id: number; user: string; body: string; createdAt: string }>,
    _branch: string,
    opts?: {
      isAlreadyAddressed?: (commentId: number) => boolean;
      markAddressed?: (commentId: number) => void;
    }
  ): Promise<void> {
    for (const comment of comments) {
      // Skip bot comments and orchestrator-authored comments
      if (comment.user === 'github-actions[bot]') continue;
      if (comment.body.includes(ORCHESTRATOR_REVIEW_MARKER)) continue;
      if (comment.body.includes('_Automated response_')) continue;
      if (opts?.isAlreadyAddressed?.(comment.id)) continue;

      console.log(`\n  Processing general comment from ${comment.user}`);
      console.log(`  Comment: "${comment.body.substring(0, 100)}${comment.body.length > 100 ? '...' : ''}"`);

      // Analyze if comment is actionable
      const analysisPrompt = `Analyze this general PR comment and determine if it requires code changes.

**Comment from ${comment.user}:** ${comment.body}

Respond in JSON format only:
{
  "actionable": true or false,
  "reason": "Brief explanation",
  "suggestedAction": "If actionable, what should be done"
}

A comment is actionable if it requests specific code changes (e.g., "use latest packages", "add error handling").
A comment is NOT actionable if it's just a question, acknowledgment, or general discussion.`;

      const analysis = await this.sdkRunner.executeTask(analysisPrompt);
      
      let isActionable = false;
      let reason = '';
      let suggestedAction = '';
      
      try {
        const jsonMatch = analysis.output?.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          isActionable = parsed.actionable === true;
          reason = parsed.reason || '';
          suggestedAction = parsed.suggestedAction || '';
        }
      } catch {
        isActionable = true;
        reason = 'Could not parse, treating as actionable';
      }

      if (isActionable) {
        console.log(`  -> Actionable: ${reason}`);
        
        const fixPrompt = `Address this PR comment by making the necessary code changes.

**Comment:** ${comment.body}
**Suggested Action:** ${suggestedAction}

Make the changes now. Focus on what the comment is asking for.`;

        await this.sdkRunner.executeTask(fixPrompt);
        
        // Reply to the comment
        await this.github.addPullRequestComment(prNumber, 
          `Addressed feedback from comment ${comment.id}: ${suggestedAction || 'Made the requested changes.'}\n\n${ORCHESTRATOR_REVIEW_MARKER}\n\n_Automated response_`
        );
        opts?.markAddressed?.(comment.id);
        console.log(`  -> Fixed and replied`);
      } else {
        console.log(`  -> Not actionable: ${reason}`);
        await this.github.addPullRequestComment(prNumber,
          `Thank you for the feedback on comment ${comment.id}. ${reason}\n\n${ORCHESTRATOR_REVIEW_MARKER}\n\n_Automated response_`
        );
        opts?.markAddressed?.(comment.id);
      }
    }
  }

  /**
   * Process each inline comment individually
   */
  private async processInlineComments(
    prNumber: number, 
    comments: Array<{ id: number; user: string; body: string; path: string; line: number | null; inReplyToId: number | null; createdAt: string }>,
    _branch: string,
    opts?: {
      isAlreadyAddressed?: (rootCommentId: number) => boolean;
      markAddressed?: (rootCommentId: number) => void;
    }
  ): Promise<void> {
    // Build a map of replies per root comment so we can detect already-addressed threads
    const repliesByRootId = new Map<number, Array<typeof comments[number]>>();
    for (const c of comments) {
      if (c.inReplyToId) {
        const list = repliesByRootId.get(c.inReplyToId) || [];
        list.push(c);
        repliesByRootId.set(c.inReplyToId, list);
      }
    }

    // Only process ROOT review comments (ignore replies)
    const rootComments = comments.filter(c => !c.inReplyToId);

    for (const comment of rootComments) {
      // Skip bot comments and any orchestrator-authored comments
      if (comment.user === 'github-actions[bot]') continue;
      if (comment.body.includes(ORCHESTRATOR_REVIEW_MARKER)) continue;

      // Skip if we already replied with our marker on this thread
      const replies = repliesByRootId.get(comment.id) || [];
      const hasAddressedReply = replies.some(r => r.body.includes(ORCHESTRATOR_REVIEW_MARKER));
      if (hasAddressedReply) {
        opts?.markAddressed?.(comment.id);
        continue;
      }

      // Skip if state says this root comment is already handled
      if (opts?.isAlreadyAddressed?.(comment.id)) {
        continue;
      }
      
      console.log(`\n  Processing comment on ${comment.path}:${comment.line || 'N/A'}`);
      console.log(`  Comment: "${comment.body.substring(0, 100)}${comment.body.length > 100 ? '...' : ''}"`);

      // Ask Claude to analyze if the comment is actionable
      const analysisPrompt = `Analyze this code review comment and determine if it requires code changes.

**File:** ${comment.path}
**Line:** ${comment.line || 'N/A'}
**Comment:** ${comment.body}

Respond in JSON format only:
{
  "actionable": true or false,
  "reason": "Brief explanation of why this is or isn't actionable",
  "suggestedFix": "If actionable, describe what code changes should be made"
}

A comment is NOT actionable if:
- It's just a question that doesn't require code changes
- It's praise or acknowledgment
- It suggests something that contradicts the requirements
- It's asking for clarification rather than requesting changes
- The suggestion would break existing functionality

A comment IS actionable if:
- It points out a bug or error
- It suggests a valid improvement
- It identifies missing error handling
- It requests a specific code change that makes sense`;

      const analysis = await this.sdkRunner.executeTask(analysisPrompt);
      
      let isActionable = false;
      let reason = '';
      let suggestedFix = '';
      
      try {
        // Parse Claude's response
        const jsonMatch = analysis.output?.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          isActionable = parsed.actionable === true;
          reason = parsed.reason || '';
          suggestedFix = parsed.suggestedFix || '';
        }
      } catch (e) {
        // If parsing fails, assume actionable to be safe
        isActionable = true;
        reason = 'Could not parse analysis, treating as actionable';
      }

      if (isActionable) {
        console.log(`  -> Actionable: ${reason}`);
        
        // Make the code changes
        const fixPrompt = `Fix the code based on this review comment.

**File:** ${comment.path}
**Line:** ${comment.line || 'N/A'}  
**Comment:** ${comment.body}
**Suggested Fix:** ${suggestedFix}

Make the necessary code changes now. Only modify the specific file mentioned.
DO NOT create any new files or documentation.`;

        await this.sdkRunner.executeTask(fixPrompt);
        
        // Reply to the comment with what was done
        await this.github.replyToReviewComment(
          prNumber, 
          comment.id, 
          `Fixed. ${suggestedFix || 'Made the requested changes.'}\n\n${ORCHESTRATOR_REVIEW_MARKER}`
        );
        opts?.markAddressed?.(comment.id);
        console.log(`  -> Fixed and replied`);
      } else {
        console.log(`  -> Not actionable: ${reason}`);
        
        // Reply explaining why no changes were made
        await this.github.replyToReviewComment(
          prNumber, 
          comment.id, 
          `Thank you for the feedback. ${reason}\n\nNo code changes were made for this comment.\n\n${ORCHESTRATOR_REVIEW_MARKER}`
        );
        opts?.markAddressed?.(comment.id);
        console.log(`  -> Replied with explanation`);
      }
    }
  }

  /**
   * Address general review feedback (not inline comments)
   */
  private async addressGeneralReviewFeedback(_branch: string, reviewBody: string): Promise<void> {
    const prompt = `A code reviewer has provided general feedback. Address it if it requires code changes.

**Review Feedback:**
${reviewBody}

**Instructions:**
- Only make code changes if the feedback clearly requires them
- DO NOT create documentation files
- If the feedback is just a question or doesn't require changes, do nothing`;

    await this.sdkRunner.executeTask(prompt);
  }

  /**
   * Address review feedback on the final PR
   */
  private async addressFinalPRReview(prNumber: number, reviewBody: string): Promise<void> {
    if (!this.state) throw new Error('No state');

    await GitOperations.checkout(this.state.workBranch);

    // Get inline review comments (code comments)
    const reviewComments = await this.github.getPullRequestComments(prNumber);
    
    // Get general PR comments (issue-style comments)
    const prComments = await this.github.getPullRequestIssueComments(prNumber);
    
    // Process inline comments individually
    if (reviewComments.length > 0) {
      console.log(`Processing ${reviewComments.length} inline code comments on final PR...`);
      await this.processInlineComments(prNumber, reviewComments, this.state.workBranch);
    }

    // Process general PR comments
    const actionableComments = prComments.filter(c => 
      c.user !== 'github-actions[bot]' && 
      !c.body.includes('Automated by Claude') &&
      !c.body.includes('_Automated response_') &&
      c.body.length > 10
    );
    
    if (actionableComments.length > 0) {
      console.log(`Processing ${actionableComments.length} general PR comments on final PR...`);
      await this.processGeneralPRComments(prNumber, actionableComments, this.state.workBranch);
    }

    // If there's also a review body, address it
    if (reviewBody && reviewBody.trim().length > 20) {
      console.log('Addressing review body feedback on final PR...');
      await this.addressGeneralReviewFeedback(this.state.workBranch, reviewBody);
    }

    // Commit and push any remaining changes
    const hasChanges = await GitOperations.hasUncommittedChanges();
    if (hasChanges) {
      await GitOperations.commitAndPush('fix: address final PR review feedback', this.state.workBranch);
      console.log('Final PR review feedback addressed and pushed');
    } else {
      console.log('All final PR review comments handled');
    }
    
    this.state.finalPr!.reviewsAddressed = (this.state.finalPr!.reviewsAddressed || 0) + 1;
    
    // Don't save state to avoid re-adding state file to PR
    // The state tracking is less critical at this point anyway
  }

  /**
   * Handle progress check - continue any pending work
   */
  private async handleProgressCheck(event: OrchestratorEvent): Promise<void> {
    const branch = event.branch || (event.issueNumber ? await findWorkBranchForIssue(event.issueNumber) : null);
    if (!branch) {
      console.log('No work branch found for progress check');
      return;
    }

    this.state = await this.loadStateFromWorkBranch(branch);
    if (!this.state) {
      console.log('No state found');
      return;
    }

    console.log(`Current phase: ${this.state.phase}`);

    switch (this.state.phase) {
      case 'initialized':
        await this.runAnalysis();
        break;
      case 'analyzing':
        console.log('Analysis in progress...');
        break;
      case 'project_setup':
        // Continue with setup phase - treat it like worker execution
        await this.continueWorkerExecution();
        break;
      case 'em_assignment':
      case 'worker_execution':
        await this.continueWorkerExecution();
        break;
      case 'worker_review':
      case 'em_review':
      case 'final_review':
        await this.checkAndMergePRs();
        break;
      case 'em_merging':
      case 'final_merge':
        await this.checkFinalMerge();
        break;
      case 'complete':
        console.log('Orchestration already complete');
        break;
      case 'failed':
        // Try to recover from failed state
        await this.attemptRecovery();
        break;
    }
  }

  /**
   * Attempt to recover from failed state
   * Looks at what work was done and tries to continue from there
   */
  private async attemptRecovery(): Promise<void> {
    if (!this.state) return;

    console.log('\n=== Attempting recovery from failed state ===');
    console.log(`Last error: ${this.state.error}`);

    // Check if we have EMs that need work
    const pendingEMs = this.state.ems.filter(em => 
      em.status === 'pending' || em.status === 'workers_running'
    );
    
    const emsWithPendingPRs = this.state.ems.filter(em => 
      em.status === 'pr_created' || em.status === 'approved'
    );
    
    const allWorkersComplete = this.state.ems.every(em => areAllWorkersComplete(em));

    // Determine best recovery action
    if (pendingEMs.length > 0) {
      // There are EMs that haven't finished - continue worker execution
      console.log(`Found ${pendingEMs.length} EMs with pending work. Resuming worker execution.`);
      await this.setPhase('worker_execution');
      this.state.error = undefined;
      addErrorToHistory(this.state, 'Recovered from failed state - resuming worker execution', undefined);
      await saveState(this.state);
      await this.updateProgressComment();
      await this.continueWorkerExecution();
      
    } else if (emsWithPendingPRs.length > 0) {
      // Workers done, but EM PRs haven't merged - try to merge them
      console.log(`Found ${emsWithPendingPRs.length} EM PRs to merge. Resuming EM merging.`);
      await this.setPhase('em_merging');
      this.state.error = undefined;
      addErrorToHistory(this.state, 'Recovered from failed state - resuming EM merging', undefined);
      await saveState(this.state);
      await this.updateProgressComment();
      await this.checkFinalMerge();
      
    } else if (allWorkersComplete && !this.state.finalPr) {
      // All work done but no final PR - create it
      console.log('All EMs complete but no final PR. Creating final PR.');
      await this.setPhase('final_merge');
      this.state.error = undefined;
      addErrorToHistory(this.state, 'Recovered from failed state - creating final PR', undefined);
      await saveState(this.state);
      await this.updateProgressComment();
      await this.createFinalPR();
      
    } else if (this.state.finalPr) {
      // Final PR exists - check if it needs review handling
      console.log(`Final PR #${this.state.finalPr.number} exists. Checking review status.`);
      await this.setPhase('final_review');
      this.state.error = undefined;
      addErrorToHistory(this.state, 'Recovered from failed state - resuming final PR review', undefined);
      await saveState(this.state);
      await this.updateProgressComment();
      
    } else {
      // No clear recovery path - start fresh analysis
      console.log('No clear recovery path. Consider restarting from analysis.');
      addErrorToHistory(this.state, 'Recovery failed - no clear path forward', `EMs: ${this.state.ems.map(e => `${e.id}:${e.status}`).join(', ')}`);
      await saveState(this.state);
      await this.updateProgressComment('Recovery failed. Manual intervention may be needed.');
    }
  }

  /**
   * Continue worker execution
   */
  private async continueWorkerExecution(): Promise<void> {
    if (!this.state) return;

    // First, check for PRs that need conflict resolution or review handling
    await this.handlePRsNeedingAttention();

    for (const em of this.state.ems) {
      if (em.status === 'pending' || em.status === 'workers_running') {
        const pendingWorker = getNextPendingWorker(em);
        if (pendingWorker) {
          await this.startNextWorker(em);
          return;
        } else if (areAllWorkersComplete(em)) {
          await this.createEMPullRequest(em);
          return;
        }
      }
    }

    // All EMs done with workers
    await this.checkFinalMerge();
  }

  /**
   * Check for worker PRs that need conflict resolution or review handling
   * This handles cases where events weren't properly triggered
   */
  private async handlePRsNeedingAttention(): Promise<void> {
    if (!this.state) return;

    for (const em of this.state.ems) {
      for (const worker of em.workers) {
        if (worker.status !== 'pr_created' || !worker.prNumber) continue;

        // Check the actual PR state on GitHub using the raw API for mergeable info
        const prDetails = await this.github.getOctokit().rest.pulls.get({
          owner: this.ctx.repo.owner,
          repo: this.ctx.repo.name,
          pull_number: worker.prNumber
        });
        
        // Handle conflicts
        if (prDetails.data.mergeable === false || prDetails.data.mergeable_state === 'dirty') {
          console.log(`\n=== Worker-${worker.id} PR #${worker.prNumber} has conflicts - resolving ===`);
          await this.resolveWorkerConflicts(em, worker);
          continue;
        }

        // Handle unaddressed reviews
        const reviews = await this.github.getPullRequestReviews(worker.prNumber);
        const reviewComments = await this.github.getPullRequestComments(worker.prNumber);
        
        // Check if there are comments that haven't been addressed
        const hasUnaddressedComments = reviewComments.length > 0 && worker.reviewsAddressed === 0;
        const hasChangesRequested = reviews.some(r => r.state === 'CHANGES_REQUESTED');
        const hasReviewWithComments = reviews.some(r => r.state === 'COMMENTED' && reviewComments.length > 0);

        if (hasUnaddressedComments || hasChangesRequested || hasReviewWithComments) {
          console.log(`\n=== Worker-${worker.id} PR #${worker.prNumber} has unaddressed reviews - handling ===`);
          await this.github.setStatusLabel(worker.prNumber, STATUS_LABELS.ADDRESSING_FEEDBACK);
          await this.addressReview(worker.branch, worker.prNumber, '');
          worker.reviewsAddressed++;
          await this.github.setStatusLabel(worker.prNumber, STATUS_LABELS.AWAITING_REVIEW);
          await saveState(this.state);
        }
      }
    }
  }

  /**
   * Resolve conflicts on a worker PR by rebasing onto the EM branch
   */
  private async resolveWorkerConflicts(em: EMState, worker: { id: number; branch: string; prNumber?: number; status: string; error?: string }): Promise<void> {
    if (!this.state || !worker.prNumber) return;

    try {
      await this.github.setStatusLabel(worker.prNumber, STATUS_LABELS.ADDRESSING_FEEDBACK);
      
      // Checkout worker branch and pull latest
      await GitOperations.checkout(worker.branch);
      await GitOperations.pull(worker.branch);

      // Attempt rebase onto EM branch
      const rebaseResult = await GitOperations.rebase(em.branch);
      
      if (!rebaseResult.success && rebaseResult.hasConflicts && rebaseResult.conflictFiles.length > 0) {
        console.log(`  Rebase has conflicts in ${rebaseResult.conflictFiles.length} files. Using Claude to resolve...`);
        
        // Use Claude to resolve conflicts
        const sessionId = generateSessionId('worker', this.state.issue.number, em.id, worker.id);
        await this.claude.resolveConflicts(
          sessionId,
          rebaseResult.conflictFiles,
          em.branch
        );
        
        // Continue rebase after resolution
        await GitOperations.continueRebase();
      }

      // Push resolved branch
      await GitOperations.push(worker.branch);
      
      // Update status
      await this.github.setStatusLabel(worker.prNumber, STATUS_LABELS.AWAITING_REVIEW);
      console.log(`  Conflicts resolved for Worker-${worker.id}`);
      
      await saveState(this.state);
    } catch (error) {
      const errMsg = (error as Error).message;
      console.error(`  Failed to resolve conflicts for Worker-${worker.id}: ${errMsg}`);
      
      // Abort rebase if in progress
      try {
        await GitOperations.abortRebase();
      } catch {}
      
      // Mark as failed if conflict resolution fails
      worker.status = 'failed';
      worker.error = `Conflict resolution failed: ${errMsg}`;
      await this.github.setStatusLabel(worker.prNumber, STATUS_LABELS.CONFLICTS);
      addErrorToHistory(this.state, `Worker-${worker.id} conflict resolution failed: ${errMsg}`, `EM-${em.id}`);
      await saveState(this.state);
    }
  }

  /**
   * Check if PRs can be merged
   */
  private async checkAndMergePRs(): Promise<void> {
    if (!this.state) return;

    for (const em of this.state.ems) {
      // Try to merge review-clean worker PRs
      for (const worker of em.workers) {
        if (!worker.prNumber) continue;
        if (worker.status !== 'pr_created' && worker.status !== 'approved') continue;
        await this.maybeAutoMergePR(worker.prNumber);
      }

      // If all workers complete (merged/skipped/failed), dispatch EM PR creation if it doesn't exist
      if (areAllWorkersComplete(em) && !em.prNumber) {
        // Event-driven: create EM PR via internal dispatch
        await this.dispatchEvent('create_em_pr', {
          issue_number: this.state.issue.number,
          em_id: em.id
        });
      }

      // Try to merge review-clean EM PRs
      if (em.prNumber && (em.status === 'pr_created' || em.status === 'approved')) {
        await this.maybeAutoMergePR(em.prNumber);
      }
    }

    await saveState(this.state);
    await this.syncPhaseForReviewIfReady();
    await this.updateProgressComment();

    // If all EMs are merged/skipped, dispatch final completion check
    const allEMsDone = this.state.ems.every(em => em.status === 'merged' || em.status === 'skipped');
    if (allEMsDone && !this.state.finalPr?.number) {
      await this.dispatchEvent('check_completion', {
        issue_number: this.state.issue.number
      });
    }
  }

  /**
   * Find work branch from a PR branch name
   */
  private async findWorkBranchFromPRBranch(prBranch: string): Promise<string | null> {
    // Branch patterns:
    // Worker: cco/issue-123-em-1-w-1
    // EM: cco/issue-123-em-1
    // Work: cco/123-slug
    const match = prBranch.match(/cco\/issue-(\d+)/);
    if (match) {
      return await findWorkBranchForIssue(parseInt(match[1], 10));
    }
    return null;
  }

  /**
   * Load state from a work branch
   */
  private async loadStateFromWorkBranch(branch: string): Promise<OrchestratorState | null> {
    await GitOperations.checkout(branch);
    await GitOperations.pull(branch);
    return await loadState();
  }
}
