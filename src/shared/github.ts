/**
 * GitHub API client wrapper
 * Provides methods for common GitHub operations used by the orchestrator
 */

import { getOctokit } from '@actions/github';
import {
  getAllOrchestratorLabels,
  isOrchestratorLabel,
  LABEL_PREFIXES,
  StatusLabel,
  TypeLabel,
  PhaseLabel,
  BASE_LABEL,
  ORCHESTRATOR_COMMENT_MARKER
} from './labels.js';

// GitHub repository context
export interface RepoContext {
  owner: string;
  repo: string;
}

// Pull request creation parameters
export interface CreatePRParams {
  title: string;
  body: string;
  head: string;
  base: string;
}

// Pull request details
export interface PullRequest {
  number: number;
  title: string;
  body: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  html_url: string;
  state: string;
  merged: boolean;
}

// Workflow dispatch parameters
export interface WorkflowDispatchInputs {
  [key: string]: string | number | boolean;
}

/**
 * GitHub API client for orchestrator operations
 */
export class GitHubClient {
  private octokit: ReturnType<typeof getOctokit>;
  private owner: string;
  private repo: string;
  private cachedWorkflowFilename?: string;  // Cache for auto-detected workflow name

  /**
   * Initialize GitHub client
   * @param token - GitHub token (PAT or GitHub token)
   * @param context - Repository context
   */
  constructor(token: string, context: RepoContext) {
    this.octokit = getOctokit(token);
    this.owner = context.owner;
    this.repo = context.repo;
  }

  /**
   * Get the repository owner and repo
   */
  private getRepo(): { owner: string; repo: string } {
    return { owner: this.owner, repo: this.repo };
  }

  /**
   * Dispatch a workflow with retry logic and idempotency
   * @param workflowId - Workflow filename or ID
   * @param ref - Git ref to run against
   * @param inputs - Workflow inputs
   * @param options - Optional retry and idempotency options
   * @returns void
   */
  async dispatchWorkflow(
    workflowId: string,
    ref: string,
    inputs: WorkflowDispatchInputs,
    options?: {
      maxRetries?: number;
      retryDelayMs?: number;
      idempotencyToken?: string;
    }
  ): Promise<void> {
    const maxRetries = options?.maxRetries ?? 3;
    const baseDelayMs = options?.retryDelayMs ?? 1000;
    
    // Add idempotency token to inputs if provided
    const finalInputs = { ...inputs };
    if (options?.idempotencyToken) {
      finalInputs.idempotency_token = options.idempotencyToken;
    }

    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.octokit.rest.actions.createWorkflowDispatch({
          owner: this.owner,
          repo: this.repo,
          workflow_id: workflowId,
          ref,
          inputs: finalInputs as Record<string, string>
        });
        return; // Success
      } catch (error) {
        lastError = error as Error;
        const errorMessage = lastError.message.toLowerCase();
        
        // Don't retry on 4xx errors (bad request, not found, etc.)
        if (errorMessage.includes('400') || 
            errorMessage.includes('404') || 
            errorMessage.includes('422')) {
          throw new Error(
            `Failed to dispatch workflow ${workflowId}: ${lastError.message}`
          );
        }
        
        // Retry on rate limits or transient errors
        if (attempt < maxRetries - 1) {
          // Exponential backoff with jitter
          const jitter = Math.random() * 0.3; // 0-30% jitter
          const delay = baseDelayMs * Math.pow(2, attempt) * (1 + jitter);
          console.log(
            `Dispatch attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms: ${lastError.message}`
          );
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw new Error(
      `Failed to dispatch workflow ${workflowId} after ${maxRetries} attempts: ${lastError?.message}`
    );
  }

  /**
   * Auto-detect the orchestrator workflow filename
   * Searches for workflows that handle 'cco' events or have orchestrator-related names
   * @returns The workflow filename (e.g., 'cco.yml')
   */
  async detectOrchestratorWorkflow(): Promise<string> {
    try {
      const { data: workflows } = await this.octokit.rest.actions.listRepoWorkflows({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo
      });

      // Prioritize workflows by name:
      // 1. cco.yml (most common name for user workflows)
      // 2. orchestrator.yml (original name)
      // 3. Any workflow with 'cco' or 'orchestrator' in the name
      const workflowNames = workflows.workflows.map(w => w.name);

      // Check for exact matches first
      if (workflowNames.includes('cco.yml')) return 'cco.yml';
      if (workflowNames.includes('orchestrator.yml')) return 'orchestrator.yml';

      // Check for partial matches
      for (const name of workflowNames) {
        if (name.toLowerCase().includes('cco') || name.toLowerCase().includes('orchestrator')) {
          return name;
        }
      }

      // Fallback to first workflow
      return workflows.workflows[0]?.name || 'cco.yml';
    } catch (error) {
      console.warn(`Failed to detect workflow, using default: ${(error as Error).message}`);
      return 'cco.yml'; // Default fallback
    }
  }

  /**
   * Dispatch a workflow with auto-detected workflow filename
   * @param eventType - Event type (start_em, execute_worker, etc.)
   * @param inputs - Workflow inputs
   * @param options - Optional retry and idempotency options
   * @returns void
   */
  async dispatchOrchestratorEvent(
    eventType: string,
    inputs: Record<string, string | number>,
    options?: {
      maxRetries?: number;
      retryDelayMs?: number;
      idempotencyToken?: string;
    }
  ): Promise<void> {
    // Auto-detect workflow filename (cache for performance)
    if (!this.cachedWorkflowFilename) {
      this.cachedWorkflowFilename = await this.detectOrchestratorWorkflow();
    }

    const maxRetries = options?.maxRetries ?? 3;
    const baseDelayMs = options?.retryDelayMs ?? 1000;

    // Add idempotency token if provided
    const finalInputs = { ...inputs };
    if (options?.idempotencyToken) {
      finalInputs.idempotency_token = options.idempotencyToken;
    }

    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        console.log(`[DEBUG] Dispatching ${eventType} to workflow: ${this.cachedWorkflowFilename}`);

        await this.octokit.rest.actions.createWorkflowDispatch({
          owner: this.getRepo().owner,
          repo: this.getRepo().repo,
          workflow_id: this.cachedWorkflowFilename,
          ref: 'main',
          inputs: finalInputs as Record<string, string>
        });

        console.log(`[DEBUG] Successfully dispatched ${eventType}`);
        return; // Success
      } catch (error) {
        lastError = error as Error;
        const errorMessage = lastError.message.toLowerCase();

        // Don't retry on 4xx errors
        if (errorMessage.includes('400') ||
            errorMessage.includes('404') ||
            errorMessage.includes('422')) {
          throw new Error(
            `Failed to dispatch ${eventType} to workflow ${this.cachedWorkflowFilename}: ${lastError.message}`
          );
        }

        // Retry on rate limits or transient errors
        if (attempt < maxRetries - 1) {
          const jitter = Math.random() * 0.3;
          const delay = baseDelayMs * Math.pow(2, attempt) * (1 + jitter);
          console.log(
            `[DEBUG] Dispatch attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms: ${lastError.message}`
          );
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw new Error(
      `Failed to dispatch ${eventType} to workflow ${this.cachedWorkflowFilename} after ${maxRetries} attempts: ${lastError?.message}`
    );
  }

  /**
   * Create a Git branch
   * @param branchName - Name of the branch to create
   * @param fromBranch - Name of the branch to create from (or SHA)
   * @returns void
   */
  async createBranch(branchName: string, fromBranch: string): Promise<void> {
    try {
      // Get the SHA of the base branch
      const { data: refData } = await this.octokit.rest.git.getRef({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        ref: `heads/${fromBranch}`
      });

      const sha = refData.object.sha;

      // Create the new branch
      await this.octokit.rest.git.createRef({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        ref: `refs/heads/${branchName}`,
        sha
      });
    } catch (error) {
      throw new Error(
        `Failed to create branch ${branchName} from ${fromBranch}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Find existing pull request by head and base branches
   * @param head - Head branch
   * @param base - Base branch
   * @returns Pull request if found, null otherwise
   */
  async findPullRequest(head: string, base: string): Promise<PullRequest | null> {
    try {
      const { data } = await this.octokit.rest.pulls.list({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        head: `${this.getRepo().owner}:${head}`,
        base,
        state: 'all'
      });

      if (data.length === 0) {
        return null;
      }

      const pr = data[0];
      return {
        number: pr.number,
        title: pr.title,
        body: pr.body || '',
        head: { ref: pr.head.ref, sha: pr.head.sha },
        base: { ref: pr.base.ref, sha: pr.base.sha },
        html_url: pr.html_url,
        state: pr.state,
        merged: pr.merged_at !== null
      };
    } catch (error) {
      console.warn(`Failed to find PR: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Create a pull request or return existing one if it already exists
   * @param params - PR creation parameters
   * @returns Pull request details
   */
  async createPullRequest(params: CreatePRParams): Promise<PullRequest> {
    try {
      // First check if PR already exists
      const existing = await this.findPullRequest(params.head, params.base);
      if (existing) {
        console.log(`PR already exists: #${existing.number} (${params.head} -> ${params.base})`);
        return existing;
      }

      const { data } = await this.octokit.rest.pulls.create({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base
      });

      return {
        number: data.number,
        title: data.title,
        body: data.body || '',
        head: { ref: data.head.ref, sha: data.head.sha },
        base: { ref: data.base.ref, sha: data.base.sha },
        html_url: data.html_url,
        state: data.state,
        merged: data.merged || false
      };
    } catch (error) {
      throw new Error(
        `Failed to create PR from ${params.head} to ${params.base}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Update or create an issue comment
   * Finds an existing orchestrator comment and updates it, or creates a new one
   * @param issueNumber - Issue number
   * @param body - Comment body
   * @returns void
   */
  async updateIssueComment(issueNumber: number, body: string): Promise<void> {
    try {
      // Look for existing orchestrator comment
      // Use per_page: 100 to handle issues with lots of comments
      const { data: comments } = await this.octokit.rest.issues.listComments({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        issue_number: issueNumber,
        per_page: 100
      });

      // Look for hidden marker comment (more reliable than visible title)
      const orchestratorComment = comments.find(comment =>
        comment.body?.includes(ORCHESTRATOR_COMMENT_MARKER)
      );

      if (orchestratorComment) {
        // Update existing comment
        await this.octokit.rest.issues.updateComment({
          owner: this.getRepo().owner,
          repo: this.getRepo().repo,
          comment_id: orchestratorComment.id,
          body
        });
      } else {
        // Create new comment
        await this.octokit.rest.issues.createComment({
          owner: this.getRepo().owner,
          repo: this.getRepo().repo,
          issue_number: issueNumber,
          body
        });
      }
    } catch (error) {
      throw new Error(
        `Failed to update issue comment for issue #${issueNumber}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Add labels to an issue
   * @param issueNumber - Issue number
   * @param labels - Labels to add
   * @returns void
   */
  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    try {
      await this.octokit.rest.issues.addLabels({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        issue_number: issueNumber,
        labels
      });
    } catch (error) {
      throw new Error(
        `Failed to add labels to issue #${issueNumber}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Remove a label from an issue
   * @param issueNumber - Issue number
   * @param label - Label to remove
   * @returns void
   */
  async removeLabel(issueNumber: number, label: string): Promise<void> {
    try {
      await this.octokit.rest.issues.removeLabel({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        issue_number: issueNumber,
        name: label
      });
    } catch (error) {
      // Ignore 404 errors (label doesn't exist)
      if ((error as any).status !== 404) {
        throw new Error(
          `Failed to remove label ${label} from issue #${issueNumber}: ${(error as Error).message}`
        );
      }
    }
  }

  /**
   * Get pull request details
   * @param prNumber - PR number
   * @returns Pull request details
   */
  async getPullRequest(prNumber: number): Promise<PullRequest> {
    try {
      const { data } = await this.octokit.rest.pulls.get({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        pull_number: prNumber
      });

      return {
        number: data.number,
        title: data.title,
        body: data.body || '',
        head: { ref: data.head.ref, sha: data.head.sha },
        base: { ref: data.base.ref, sha: data.base.sha },
        html_url: data.html_url,
        state: data.state,
        merged: data.merged || false
      };
    } catch (error) {
      throw new Error(
        `Failed to get PR #${prNumber}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Update a PR branch with latest base branch changes
   * @param prNumber - PR number
   * @returns true if update successful, false otherwise
   */
  async updatePullRequestBranch(prNumber: number): Promise<boolean> {
    try {
      await this.octokit.rest.pulls.updateBranch({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        pull_number: prNumber
      });
      console.log(`Updated PR #${prNumber} branch`);
      return true;
    } catch (error) {
      console.warn(`Failed to update PR #${prNumber} branch: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * Merge a pull request
   * @param prNumber - PR number
   * @param commitTitle - Merge commit title (optional)
   * @param commitMessage - Merge commit message (optional)
   * @returns void
   */
  async mergePullRequest(
    prNumber: number,
    commitTitle?: string,
    commitMessage?: string
  ): Promise<{ merged: boolean; alreadyMerged: boolean; error?: string }> {
    try {
      // First check if PR is already merged or closed
      const pr = await this.getPullRequest(prNumber);
      if (pr.merged) {
        console.log(`PR #${prNumber} is already merged`);
        return { merged: true, alreadyMerged: true };
      }
      if (pr.state === 'closed') {
        console.log(`PR #${prNumber} is closed but not merged`);
        return { merged: false, alreadyMerged: false, error: 'PR is closed' };
      }

      const mergeOptions: Parameters<typeof this.octokit.rest.pulls.merge>[0] = {
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        pull_number: prNumber,
        merge_method: 'squash'
      };

      if (commitTitle) {
        mergeOptions.commit_title = commitTitle;
      }
      if (commitMessage) {
        mergeOptions.commit_message = commitMessage;
      }

      console.log(`Attempting to merge PR #${prNumber} with method: squash`);
      await this.octokit.rest.pulls.merge(mergeOptions);
      console.log(`PR #${prNumber} merged successfully`);
      return { merged: true, alreadyMerged: false };
    } catch (error) {
      const err = error as any;
      const message = err.message || String(error);
      const status = err.status;
      const documentationUrl = err.documentation_url;

      console.error(`PR #${prNumber} merge failed: status=${status}, message=${message}`);

      // Check if it's a non-fatal merge error
      if (message.includes('not mergeable') || message.includes('405') || status === 405) {
        console.warn(`PR #${prNumber} is not mergeable (likely conflicts): ${message}`);
        return { merged: false, alreadyMerged: false, error: 'Not mergeable - conflicts' };
      }
      if (message.includes('Base branch was modified') || message.includes('merge conflict')) {
        console.warn(`PR #${prNumber} base branch was modified, needs update: ${message}`);
        return { merged: false, alreadyMerged: false, error: 'Base branch modified - needs update' };
      }
      if (message.includes('Head branch was modified')) {
        console.warn(`PR #${prNumber} head branch was modified: ${message}`);
        return { merged: false, alreadyMerged: false, error: 'Head branch modified' };
      }
      // Handle status check failures
      if (message.includes('Required status check') || status === 405 || documentationUrl?.includes('status')) {
        console.warn(`PR #${prNumber} failing status checks: ${message}`);
        return { merged: false, alreadyMerged: false, error: 'Failing status checks' };
      }
      throw new Error(
        `Failed to merge PR #${prNumber}: ${message}`
      );
    }
  }

  /**
   * List pull requests
   * @param head - Filter by head branch (optional)
   * @param base - Filter by base branch (optional)
   * @param state - Filter by state (open, closed, all)
   * @returns Array of pull requests
   */
  async listPullRequests(
    head?: string,
    base?: string,
    state: 'open' | 'closed' | 'all' = 'open'
  ): Promise<PullRequest[]> {
    try {
      const { data } = await this.octokit.rest.pulls.list({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        head,
        base,
        state
      });

      return data.map(pr => ({
        number: pr.number,
        title: pr.title,
        body: pr.body || '',
        head: { ref: pr.head.ref, sha: pr.head.sha },
        base: { ref: pr.base.ref, sha: pr.base.sha },
        html_url: pr.html_url,
        state: pr.state,
        merged: ('merged' in pr ? (pr as any).merged : false) as boolean
      }));
    } catch (error) {
      throw new Error(
        `Failed to list pull requests: ${(error as Error).message}`
      );
    }
  }

  /**
   * Get issue details
   * @param issueNumber - Issue number
   * @returns Issue details
   */
  async getIssue(issueNumber: number): Promise<{
    number: number;
    title: string;
    body: string;
    state: string;
    labels: string[];
  }> {
    try {
      const { data } = await this.octokit.rest.issues.get({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        issue_number: issueNumber
      });

      return {
        number: data.number,
        title: data.title,
        body: data.body || '',
        state: data.state,
        labels: data.labels.map(l => typeof l === 'string' ? l : (l.name || 'unknown')).filter(Boolean)
      };
    } catch (error) {
      throw new Error(
        `Failed to get issue #${issueNumber}: ${(error as Error).message}`
      );
    }
  }

  /**
   * List issues with a specific label
   * @param label - Label to filter by
   * @param state - Filter by state (open, closed, all)
   * @returns Array of issues
   */
  async listIssuesByLabel(
    label: string,
    state: 'open' | 'closed' | 'all' = 'open'
  ): Promise<
    Array<{ number: number; title: string; body: string; state: string }>
  > {
    try {
      const { data } = await this.octokit.rest.issues.listForRepo({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        labels: label,
        state
      });

      return data.map(issue => ({
        number: issue.number,
        title: issue.title,
        body: issue.body || '',
        state: issue.state
      }));
    } catch (error) {
      throw new Error(
        `Failed to list issues with label ${label}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Delete a branch
   * @param branchName - Name of the branch to delete
   * @returns void
   */
  async deleteBranch(branchName: string): Promise<void> {
    try {
      await this.octokit.rest.git.deleteRef({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        ref: `heads/${branchName}`
      });
    } catch (error) {
      throw new Error(
        `Failed to delete branch ${branchName}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Get the underlying octokit instance
   * @returns Octokit instance
   */
  getOctokit() {
    return this.octokit;
  }

  /**
   * Ensure all orchestrator labels exist in the repository
   * Creates them if they don't exist
   */
  async ensureLabelsExist(): Promise<void> {
    const labels = getAllOrchestratorLabels();
    
    for (const label of labels) {
      try {
        await this.octokit.rest.issues.getLabel({
          owner: this.owner,
          repo: this.repo,
          name: label.name
        });
      } catch (error) {
        if ((error as any).status === 404) {
          try {
            await this.octokit.rest.issues.createLabel({
              owner: this.owner,
              repo: this.repo,
              name: label.name,
              color: label.color,
              description: label.description
            });
            console.log(`Created label: ${label.name}`);
          } catch (createError) {
            console.warn(`Failed to create label ${label.name}: ${(createError as Error).message}`);
          }
        }
      }
    }
  }

  /**
   * Get all labels on an issue or PR
   * @param issueNumber - Issue/PR number
   * @returns Array of label names
   */
  async getLabels(issueNumber: number): Promise<string[]> {
    try {
      const { data } = await this.octokit.rest.issues.listLabelsOnIssue({
        owner: this.owner,
        repo: this.repo,
        issue_number: issueNumber
      });
      return data.map(l => l.name);
    } catch (error) {
      console.warn(`Failed to get labels for #${issueNumber}: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Set a status label on a PR, removing any existing status labels
   * @param prNumber - PR number
   * @param status - Status label to set
   */
  async setStatusLabel(prNumber: number, status: StatusLabel): Promise<void> {
    try {
      const currentLabels = await this.getLabels(prNumber);
      
      // Remove existing status labels
      const statusLabels = currentLabels.filter(l => l.startsWith(LABEL_PREFIXES.STATUS));
      for (const label of statusLabels) {
        if (label !== status) {
          await this.removeLabel(prNumber, label);
        }
      }
      
      // Add new status label if not already present
      if (!currentLabels.includes(status)) {
        await this.addLabels(prNumber, [status]);
      }
    } catch (error) {
      console.warn(`Failed to set status label on PR #${prNumber}: ${(error as Error).message}`);
    }
  }

  /**
   * Set initial labels on a new PR (type + status + base)
   * @param prNumber - PR number
   * @param type - Type label
   * @param status - Initial status label
   * @param emId - Optional EM ID for worker PRs
   */
  async setPRLabels(
    prNumber: number, 
    type: TypeLabel, 
    status: StatusLabel,
    emId?: number
  ): Promise<void> {
    try {
      const labels = [BASE_LABEL, type, status];
      if (emId !== undefined) {
        labels.push(`${LABEL_PREFIXES.EM}${emId}`);
      }
      await this.addLabels(prNumber, labels);
    } catch (error) {
      console.warn(`Failed to set PR labels on #${prNumber}: ${(error as Error).message}`);
    }
  }

  /**
   * Update the phase label on an issue
   * @param issueNumber - Issue number
   * @param phase - Phase label to set
   */
  async setPhaseLabel(issueNumber: number, phase: PhaseLabel): Promise<void> {
    try {
      const currentLabels = await this.getLabels(issueNumber);
      
      // Remove existing phase labels
      const phaseLabels = currentLabels.filter(l => l.startsWith(LABEL_PREFIXES.PHASE));
      for (const label of phaseLabels) {
        if (label !== phase) {
          await this.removeLabel(issueNumber, label);
        }
      }
      
      // Add new phase label if not already present
      if (!currentLabels.includes(phase)) {
        await this.addLabels(issueNumber, [phase]);
      }
    } catch (error) {
      console.warn(`Failed to set phase label on issue #${issueNumber}: ${(error as Error).message}`);
    }
  }

  /**
   * Remove all orchestrator labels from an issue/PR
   * @param issueNumber - Issue/PR number
   */
  async removeOrchestratorLabels(issueNumber: number): Promise<void> {
    try {
      const currentLabels = await this.getLabels(issueNumber);
      const orchestratorLabels = currentLabels.filter(isOrchestratorLabel);
      
      for (const label of orchestratorLabels) {
        await this.removeLabel(issueNumber, label);
      }
    } catch (error) {
      console.warn(`Failed to remove orchestrator labels from #${issueNumber}: ${(error as Error).message}`);
    }
  }

  /**
   * Get reviews for a pull request
   * @param prNumber - PR number
   * @returns Array of reviews
   */
  async getPullRequestReviews(prNumber: number): Promise<Array<{
    id: number;
    user: string;
    state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
    body: string;
    submittedAt: string;
  }>> {
    try {
      const { data } = await this.octokit.rest.pulls.listReviews({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        pull_number: prNumber
      });

      return data.map(review => ({
        id: review.id,
        user: review.user?.login || 'unknown',
        state: review.state as 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING',
        body: review.body || '',
        submittedAt: review.submitted_at || ''
      }));
    } catch (error) {
      throw new Error(
        `Failed to get reviews for PR #${prNumber}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Get review comments for a pull request
   * @param prNumber - PR number
   * @returns Array of review comments
   */
  async getPullRequestComments(prNumber: number): Promise<Array<{
    id: number;
    user: string;
    body: string;
    path: string;
    line: number | null;
    inReplyToId: number | null;
    createdAt: string;
  }>> {
    try {
      const { data } = await this.octokit.rest.pulls.listReviewComments({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        pull_number: prNumber
      });

      return data.map(comment => ({
        id: comment.id,
        user: comment.user?.login || 'unknown',
        body: comment.body,
        path: comment.path,
        line: comment.line || null,
        inReplyToId: (comment as any).in_reply_to_id ?? null,
        createdAt: comment.created_at
      }));
    } catch (error) {
      throw new Error(
        `Failed to get comments for PR #${prNumber}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Reply to a review comment
   * @param prNumber - PR number
   * @param commentId - Comment ID to reply to
   * @param body - Reply body
   * @returns void
   */
  async replyToReviewComment(prNumber: number, commentId: number, body: string): Promise<void> {
    try {
      await this.octokit.rest.pulls.createReplyForReviewComment({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        pull_number: prNumber,
        comment_id: commentId,
        body
      });
    } catch (error) {
      throw new Error(
        `Failed to reply to comment ${commentId} on PR #${prNumber}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Add a comment to a pull request (not a review comment)
   * @param prNumber - PR number
   * @param body - Comment body
   * @returns void
   */
  async addPullRequestComment(prNumber: number, body: string): Promise<void> {
    try {
      await this.octokit.rest.issues.createComment({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        issue_number: prNumber,
        body
      });
    } catch (error) {
      throw new Error(
        `Failed to add comment to PR #${prNumber}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Get all issue-style comments on a PR (general comments, not inline review comments)
   * @param prNumber - PR number
   * @returns Array of comments
   */
  async getPullRequestIssueComments(prNumber: number): Promise<Array<{
    id: number;
    user: string;
    body: string;
    createdAt: string;
  }>> {
    try {
      const { data } = await this.octokit.rest.issues.listComments({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        issue_number: prNumber
      });

      return data.map(comment => ({
        id: comment.id,
        user: comment.user?.login || 'unknown',
        body: comment.body || '',
        createdAt: comment.created_at
      }));
    } catch (error) {
      throw new Error(
        `Failed to get PR comments: ${(error as Error).message}`
      );
    }
  }
}
