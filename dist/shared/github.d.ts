/**
 * GitHub API client wrapper
 * Provides methods for common GitHub operations used by the orchestrator
 */
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
     * Dispatch a workflow
     * @param workflowId - Workflow filename or ID
     * @param ref - Git ref to run against
     * @param inputs - Workflow inputs
     * @returns void
     */
    dispatchWorkflow(workflowId: string, ref: string, inputs: WorkflowDispatchInputs): Promise<void>;
    /**
     * Create a Git branch
     * @param branchName - Name of the branch to create
     * @param fromBranch - Name of the branch to create from (or SHA)
     * @returns void
     */
    createBranch(branchName: string, fromBranch: string): Promise<void>;
    /**
     * Create a pull request
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
     * Merge a pull request
     * @param prNumber - PR number
     * @param commitTitle - Merge commit title (optional)
     * @param commitMessage - Merge commit message (optional)
     * @returns void
     */
    mergePullRequest(prNumber: number, commitTitle?: string, commitMessage?: string): Promise<void>;
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
    getOctokit(): import("@octokit/core").Octokit & import("@octokit/plugin-rest-endpoint-methods/dist-types/types").Api & {
        paginate: import("@octokit/plugin-paginate-rest").PaginateInterface;
    };
}
//# sourceMappingURL=github.d.ts.map