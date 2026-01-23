/**
 * GitHub API client wrapper
 * Provides methods for common GitHub operations used by the orchestrator
 */
import { StatusLabel, TypeLabel, PhaseLabel } from './labels.js';
export interface RepoContext {
    owner: string;
    repo: string;
}
export interface CreatePRParams {
    title: string;
    body: string;
    head: string;
    base: string;
}
export interface PullRequest {
    number: number;
    title: string;
    body: string;
    head: {
        ref: string;
        sha: string;
    };
    base: {
        ref: string;
        sha: string;
    };
    html_url: string;
    state: string;
    merged: boolean;
}
export interface WorkflowDispatchInputs {
    [key: string]: string | number | boolean;
}
/**
 * GitHub API client for orchestrator operations
 */
export declare class GitHubClient {
    private octokit;
    private owner;
    private repo;
    /**
     * Initialize GitHub client
     * @param token - GitHub token (PAT or GitHub token)
     * @param context - Repository context
     */
    constructor(token: string, context: RepoContext);
    /**
     * Get the repository owner and repo
     */
    private getRepo;
    /**
     * Dispatch a workflow with retry logic and idempotency
     * @param workflowId - Workflow filename or ID
     * @param ref - Git ref to run against
     * @param inputs - Workflow inputs
     * @param options - Optional retry and idempotency options
     * @returns void
     */
    dispatchWorkflow(workflowId: string, ref: string, inputs: WorkflowDispatchInputs, options?: {
        maxRetries?: number;
        retryDelayMs?: number;
        idempotencyToken?: string;
    }): Promise<void>;
    /**
     * Dispatch a repository event to trigger workflows
     * This is preferable to workflow_dispatch as it doesn't require knowing the workflow filename
     * @param eventType - The event type to dispatch
     * @param payload - The event payload
     * @returns void
     */
    dispatchRepositoryEvent(eventType: string, payload: Record<string, unknown>): Promise<void>;
    /**
     * Create a Git branch
     * @param branchName - Name of the branch to create
     * @param fromBranch - Name of the branch to create from (or SHA)
     * @returns void
     */
    createBranch(branchName: string, fromBranch: string): Promise<void>;
    /**
     * Find existing pull request by head and base branches
     * @param head - Head branch
     * @param base - Base branch
     * @returns Pull request if found, null otherwise
     */
    findPullRequest(head: string, base: string): Promise<PullRequest | null>;
    /**
     * Create a pull request or return existing one if it already exists
     * @param params - PR creation parameters
     * @returns Pull request details
     */
    createPullRequest(params: CreatePRParams): Promise<PullRequest>;
    /**
     * Update or create an issue comment
     * Finds an existing orchestrator comment and updates it, or creates a new one
     * @param issueNumber - Issue number
     * @param body - Comment body
     * @returns void
     */
    updateIssueComment(issueNumber: number, body: string): Promise<void>;
    /**
     * Add labels to an issue
     * @param issueNumber - Issue number
     * @param labels - Labels to add
     * @returns void
     */
    addLabels(issueNumber: number, labels: string[]): Promise<void>;
    /**
     * Remove a label from an issue
     * @param issueNumber - Issue number
     * @param label - Label to remove
     * @returns void
     */
    removeLabel(issueNumber: number, label: string): Promise<void>;
    /**
     * Get pull request details
     * @param prNumber - PR number
     * @returns Pull request details
     */
    getPullRequest(prNumber: number): Promise<PullRequest>;
    /**
     * Update a PR branch with latest base branch changes
     * @param prNumber - PR number
     * @returns true if update successful, false otherwise
     */
    updatePullRequestBranch(prNumber: number): Promise<boolean>;
    /**
     * Merge a pull request
     * @param prNumber - PR number
     * @param commitTitle - Merge commit title (optional)
     * @param commitMessage - Merge commit message (optional)
     * @returns void
     */
    mergePullRequest(prNumber: number, commitTitle?: string, commitMessage?: string): Promise<{
        merged: boolean;
        alreadyMerged: boolean;
        error?: string;
    }>;
    /**
     * List pull requests
     * @param head - Filter by head branch (optional)
     * @param base - Filter by base branch (optional)
     * @param state - Filter by state (open, closed, all)
     * @returns Array of pull requests
     */
    listPullRequests(head?: string, base?: string, state?: 'open' | 'closed' | 'all'): Promise<PullRequest[]>;
    /**
     * Get issue details
     * @param issueNumber - Issue number
     * @returns Issue details
     */
    getIssue(issueNumber: number): Promise<{
        number: number;
        title: string;
        body: string;
        state: string;
        labels: string[];
    }>;
    /**
     * List issues with a specific label
     * @param label - Label to filter by
     * @param state - Filter by state (open, closed, all)
     * @returns Array of issues
     */
    listIssuesByLabel(label: string, state?: 'open' | 'closed' | 'all'): Promise<Array<{
        number: number;
        title: string;
        body: string;
        state: string;
    }>>;
    /**
     * Delete a branch
     * @param branchName - Name of the branch to delete
     * @returns void
     */
    deleteBranch(branchName: string): Promise<void>;
    /**
     * Get the underlying octokit instance
     * @returns Octokit instance
     */
    getOctokit(): import("@octokit/core").Octokit & import("@octokit/plugin-rest-endpoint-methods/dist-types/types.js").Api & {
        paginate: import("@octokit/plugin-paginate-rest").PaginateInterface;
    };
    /**
     * Ensure all orchestrator labels exist in the repository
     * Creates them if they don't exist
     */
    ensureLabelsExist(): Promise<void>;
    /**
     * Get all labels on an issue or PR
     * @param issueNumber - Issue/PR number
     * @returns Array of label names
     */
    getLabels(issueNumber: number): Promise<string[]>;
    /**
     * Set a status label on a PR, removing any existing status labels
     * @param prNumber - PR number
     * @param status - Status label to set
     */
    setStatusLabel(prNumber: number, status: StatusLabel): Promise<void>;
    /**
     * Set initial labels on a new PR (type + status + base)
     * @param prNumber - PR number
     * @param type - Type label
     * @param status - Initial status label
     * @param emId - Optional EM ID for worker PRs
     */
    setPRLabels(prNumber: number, type: TypeLabel, status: StatusLabel, emId?: number): Promise<void>;
    /**
     * Update the phase label on an issue
     * @param issueNumber - Issue number
     * @param phase - Phase label to set
     */
    setPhaseLabel(issueNumber: number, phase: PhaseLabel): Promise<void>;
    /**
     * Remove all orchestrator labels from an issue/PR
     * @param issueNumber - Issue/PR number
     */
    removeOrchestratorLabels(issueNumber: number): Promise<void>;
    /**
     * Get reviews for a pull request
     * @param prNumber - PR number
     * @returns Array of reviews
     */
    getPullRequestReviews(prNumber: number): Promise<Array<{
        id: number;
        user: string;
        state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
        body: string;
        submittedAt: string;
    }>>;
    /**
     * Get review comments for a pull request
     * @param prNumber - PR number
     * @returns Array of review comments
     */
    getPullRequestComments(prNumber: number): Promise<Array<{
        id: number;
        user: string;
        body: string;
        path: string;
        line: number | null;
        inReplyToId: number | null;
        createdAt: string;
    }>>;
    /**
     * Reply to a review comment
     * @param prNumber - PR number
     * @param commentId - Comment ID to reply to
     * @param body - Reply body
     * @returns void
     */
    replyToReviewComment(prNumber: number, commentId: number, body: string): Promise<void>;
    /**
     * Add a comment to a pull request (not a review comment)
     * @param prNumber - PR number
     * @param body - Comment body
     * @returns void
     */
    addPullRequestComment(prNumber: number, body: string): Promise<void>;
    /**
     * Get all issue-style comments on a PR (general comments, not inline review comments)
     * @param prNumber - PR number
     * @returns Array of comments
     */
    getPullRequestIssueComments(prNumber: number): Promise<Array<{
        id: number;
        user: string;
        body: string;
        createdAt: string;
    }>>;
}
//# sourceMappingURL=github.d.ts.map