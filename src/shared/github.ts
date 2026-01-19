/**
 * GitHub API client wrapper
 * Provides methods for common GitHub operations used by the orchestrator
 */

import { getOctokit } from '@actions/github';

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
   * Dispatch a workflow
   * @param workflowId - Workflow filename or ID
   * @param ref - Git ref to run against
   * @param inputs - Workflow inputs
   * @returns void
   */
  async dispatchWorkflow(
    workflowId: string,
    ref: string,
    inputs: WorkflowDispatchInputs
  ): Promise<void> {
    try {
      await this.octokit.rest.actions.createWorkflowDispatch({
        owner: this.owner,
        repo: this.repo,
        workflow_id: workflowId,
        ref,
        inputs: inputs as Record<string, string>
      });
    } catch (error) {
      throw new Error(
        `Failed to dispatch workflow ${workflowId}: ${(error as Error).message}`
      );
    }
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
   * Create a pull request
   * @param params - PR creation parameters
   * @returns Pull request details
   */
  async createPullRequest(params: CreatePRParams): Promise<PullRequest> {
    try {
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

      const orchestratorComment = comments.find(comment =>
        comment.body?.includes('## 🤖 Orchestration Status')
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
   * Merge a pull request
   * @param prNumber - PR number
   * @param commitTitle - Merge commit title
   * @param commitMessage - Merge commit message
   * @returns void
   */
  async mergePullRequest(
    prNumber: number,
    commitTitle: string,
    commitMessage?: string
  ): Promise<void> {
    try {
      await this.octokit.rest.pulls.merge({
        owner: this.getRepo().owner,
        repo: this.getRepo().repo,
        pull_number: prNumber,
        commit_title: commitTitle,
        commit_message: commitMessage || ''
      });
    } catch (error) {
      throw new Error(
        `Failed to merge PR #${prNumber}: ${(error as Error).message}`
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
}
