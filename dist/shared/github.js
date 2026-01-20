/**
 * GitHub API client wrapper
 * Provides methods for common GitHub operations used by the orchestrator
 */
import { getOctokit } from '@actions/github';
import { getAllOrchestratorLabels, isOrchestratorLabel, LABEL_PREFIXES, BASE_LABEL, ORCHESTRATOR_COMMENT_MARKER } from './labels.js';
/**
 * GitHub API client for orchestrator operations
 */
export class GitHubClient {
    octokit;
    owner;
    repo;
    /**
     * Initialize GitHub client
     * @param token - GitHub token (PAT or GitHub token)
     * @param context - Repository context
     */
    constructor(token, context) {
        this.octokit = getOctokit(token);
        this.owner = context.owner;
        this.repo = context.repo;
    }
    /**
     * Get the repository owner and repo
     */
    getRepo() {
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
    async dispatchWorkflow(workflowId, ref, inputs, options) {
        const maxRetries = options?.maxRetries ?? 3;
        const baseDelayMs = options?.retryDelayMs ?? 1000;
        // Add idempotency token to inputs if provided
        const finalInputs = { ...inputs };
        if (options?.idempotencyToken) {
            finalInputs.idempotency_token = options.idempotencyToken;
        }
        let lastError = null;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                await this.octokit.rest.actions.createWorkflowDispatch({
                    owner: this.owner,
                    repo: this.repo,
                    workflow_id: workflowId,
                    ref,
                    inputs: finalInputs
                });
                return; // Success
            }
            catch (error) {
                lastError = error;
                const errorMessage = lastError.message.toLowerCase();
                // Don't retry on 4xx errors (bad request, not found, etc.)
                if (errorMessage.includes('400') ||
                    errorMessage.includes('404') ||
                    errorMessage.includes('422')) {
                    throw new Error(`Failed to dispatch workflow ${workflowId}: ${lastError.message}`);
                }
                // Retry on rate limits or transient errors
                if (attempt < maxRetries - 1) {
                    // Exponential backoff with jitter
                    const jitter = Math.random() * 0.3; // 0-30% jitter
                    const delay = baseDelayMs * Math.pow(2, attempt) * (1 + jitter);
                    console.log(`Dispatch attempt ${attempt + 1} failed, retrying in ${Math.round(delay)}ms: ${lastError.message}`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        throw new Error(`Failed to dispatch workflow ${workflowId} after ${maxRetries} attempts: ${lastError?.message}`);
    }
    /**
     * Create a Git branch
     * @param branchName - Name of the branch to create
     * @param fromBranch - Name of the branch to create from (or SHA)
     * @returns void
     */
    async createBranch(branchName, fromBranch) {
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
        }
        catch (error) {
            throw new Error(`Failed to create branch ${branchName} from ${fromBranch}: ${error.message}`);
        }
    }
    /**
     * Find existing pull request by head and base branches
     * @param head - Head branch
     * @param base - Base branch
     * @returns Pull request if found, null otherwise
     */
    async findPullRequest(head, base) {
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
        }
        catch (error) {
            console.warn(`Failed to find PR: ${error.message}`);
            return null;
        }
    }
    /**
     * Create a pull request or return existing one if it already exists
     * @param params - PR creation parameters
     * @returns Pull request details
     */
    async createPullRequest(params) {
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
        }
        catch (error) {
            throw new Error(`Failed to create PR from ${params.head} to ${params.base}: ${error.message}`);
        }
    }
    /**
     * Update or create an issue comment
     * Finds an existing orchestrator comment and updates it, or creates a new one
     * @param issueNumber - Issue number
     * @param body - Comment body
     * @returns void
     */
    async updateIssueComment(issueNumber, body) {
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
            const orchestratorComment = comments.find(comment => comment.body?.includes(ORCHESTRATOR_COMMENT_MARKER));
            if (orchestratorComment) {
                // Update existing comment
                await this.octokit.rest.issues.updateComment({
                    owner: this.getRepo().owner,
                    repo: this.getRepo().repo,
                    comment_id: orchestratorComment.id,
                    body
                });
            }
            else {
                // Create new comment
                await this.octokit.rest.issues.createComment({
                    owner: this.getRepo().owner,
                    repo: this.getRepo().repo,
                    issue_number: issueNumber,
                    body
                });
            }
        }
        catch (error) {
            throw new Error(`Failed to update issue comment for issue #${issueNumber}: ${error.message}`);
        }
    }
    /**
     * Add labels to an issue
     * @param issueNumber - Issue number
     * @param labels - Labels to add
     * @returns void
     */
    async addLabels(issueNumber, labels) {
        try {
            await this.octokit.rest.issues.addLabels({
                owner: this.getRepo().owner,
                repo: this.getRepo().repo,
                issue_number: issueNumber,
                labels
            });
        }
        catch (error) {
            throw new Error(`Failed to add labels to issue #${issueNumber}: ${error.message}`);
        }
    }
    /**
     * Remove a label from an issue
     * @param issueNumber - Issue number
     * @param label - Label to remove
     * @returns void
     */
    async removeLabel(issueNumber, label) {
        try {
            await this.octokit.rest.issues.removeLabel({
                owner: this.getRepo().owner,
                repo: this.getRepo().repo,
                issue_number: issueNumber,
                name: label
            });
        }
        catch (error) {
            // Ignore 404 errors (label doesn't exist)
            if (error.status !== 404) {
                throw new Error(`Failed to remove label ${label} from issue #${issueNumber}: ${error.message}`);
            }
        }
    }
    /**
     * Get pull request details
     * @param prNumber - PR number
     * @returns Pull request details
     */
    async getPullRequest(prNumber) {
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
        }
        catch (error) {
            throw new Error(`Failed to get PR #${prNumber}: ${error.message}`);
        }
    }
    /**
     * Update a PR branch with latest base branch changes
     * @param prNumber - PR number
     * @returns true if update successful, false otherwise
     */
    async updatePullRequestBranch(prNumber) {
        try {
            await this.octokit.rest.pulls.updateBranch({
                owner: this.getRepo().owner,
                repo: this.getRepo().repo,
                pull_number: prNumber
            });
            console.log(`Updated PR #${prNumber} branch`);
            return true;
        }
        catch (error) {
            console.warn(`Failed to update PR #${prNumber} branch: ${error.message}`);
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
    async mergePullRequest(prNumber, commitTitle, commitMessage) {
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
            const mergeOptions = {
                owner: this.getRepo().owner,
                repo: this.getRepo().repo,
                pull_number: prNumber
            };
            if (commitTitle) {
                mergeOptions.commit_title = commitTitle;
            }
            if (commitMessage) {
                mergeOptions.commit_message = commitMessage;
            }
            await this.octokit.rest.pulls.merge(mergeOptions);
            return { merged: true, alreadyMerged: false };
        }
        catch (error) {
            const message = error.message;
            // Check if it's a non-fatal merge error
            if (message.includes('not mergeable') || message.includes('405')) {
                console.warn(`PR #${prNumber} is not mergeable (likely conflicts): ${message}`);
                return { merged: false, alreadyMerged: false, error: 'Not mergeable - conflicts' };
            }
            if (message.includes('Base branch was modified')) {
                console.warn(`PR #${prNumber} base branch was modified, needs update: ${message}`);
                return { merged: false, alreadyMerged: false, error: 'Base branch modified - needs update' };
            }
            if (message.includes('Head branch was modified')) {
                console.warn(`PR #${prNumber} head branch was modified: ${message}`);
                return { merged: false, alreadyMerged: false, error: 'Head branch modified' };
            }
            throw new Error(`Failed to merge PR #${prNumber}: ${message}`);
        }
    }
    /**
     * List pull requests
     * @param head - Filter by head branch (optional)
     * @param base - Filter by base branch (optional)
     * @param state - Filter by state (open, closed, all)
     * @returns Array of pull requests
     */
    async listPullRequests(head, base, state = 'open') {
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
                merged: ('merged' in pr ? pr.merged : false)
            }));
        }
        catch (error) {
            throw new Error(`Failed to list pull requests: ${error.message}`);
        }
    }
    /**
     * Get issue details
     * @param issueNumber - Issue number
     * @returns Issue details
     */
    async getIssue(issueNumber) {
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
        }
        catch (error) {
            throw new Error(`Failed to get issue #${issueNumber}: ${error.message}`);
        }
    }
    /**
     * List issues with a specific label
     * @param label - Label to filter by
     * @param state - Filter by state (open, closed, all)
     * @returns Array of issues
     */
    async listIssuesByLabel(label, state = 'open') {
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
        }
        catch (error) {
            throw new Error(`Failed to list issues with label ${label}: ${error.message}`);
        }
    }
    /**
     * Delete a branch
     * @param branchName - Name of the branch to delete
     * @returns void
     */
    async deleteBranch(branchName) {
        try {
            await this.octokit.rest.git.deleteRef({
                owner: this.getRepo().owner,
                repo: this.getRepo().repo,
                ref: `heads/${branchName}`
            });
        }
        catch (error) {
            throw new Error(`Failed to delete branch ${branchName}: ${error.message}`);
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
    async ensureLabelsExist() {
        const labels = getAllOrchestratorLabels();
        for (const label of labels) {
            try {
                await this.octokit.rest.issues.getLabel({
                    owner: this.owner,
                    repo: this.repo,
                    name: label.name
                });
            }
            catch (error) {
                if (error.status === 404) {
                    try {
                        await this.octokit.rest.issues.createLabel({
                            owner: this.owner,
                            repo: this.repo,
                            name: label.name,
                            color: label.color,
                            description: label.description
                        });
                        console.log(`Created label: ${label.name}`);
                    }
                    catch (createError) {
                        console.warn(`Failed to create label ${label.name}: ${createError.message}`);
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
    async getLabels(issueNumber) {
        try {
            const { data } = await this.octokit.rest.issues.listLabelsOnIssue({
                owner: this.owner,
                repo: this.repo,
                issue_number: issueNumber
            });
            return data.map(l => l.name);
        }
        catch (error) {
            console.warn(`Failed to get labels for #${issueNumber}: ${error.message}`);
            return [];
        }
    }
    /**
     * Set a status label on a PR, removing any existing status labels
     * @param prNumber - PR number
     * @param status - Status label to set
     */
    async setStatusLabel(prNumber, status) {
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
        }
        catch (error) {
            console.warn(`Failed to set status label on PR #${prNumber}: ${error.message}`);
        }
    }
    /**
     * Set initial labels on a new PR (type + status + base)
     * @param prNumber - PR number
     * @param type - Type label
     * @param status - Initial status label
     * @param emId - Optional EM ID for worker PRs
     */
    async setPRLabels(prNumber, type, status, emId) {
        try {
            const labels = [BASE_LABEL, type, status];
            if (emId !== undefined) {
                labels.push(`${LABEL_PREFIXES.EM}${emId}`);
            }
            await this.addLabels(prNumber, labels);
        }
        catch (error) {
            console.warn(`Failed to set PR labels on #${prNumber}: ${error.message}`);
        }
    }
    /**
     * Update the phase label on an issue
     * @param issueNumber - Issue number
     * @param phase - Phase label to set
     */
    async setPhaseLabel(issueNumber, phase) {
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
        }
        catch (error) {
            console.warn(`Failed to set phase label on issue #${issueNumber}: ${error.message}`);
        }
    }
    /**
     * Remove all orchestrator labels from an issue/PR
     * @param issueNumber - Issue/PR number
     */
    async removeOrchestratorLabels(issueNumber) {
        try {
            const currentLabels = await this.getLabels(issueNumber);
            const orchestratorLabels = currentLabels.filter(isOrchestratorLabel);
            for (const label of orchestratorLabels) {
                await this.removeLabel(issueNumber, label);
            }
        }
        catch (error) {
            console.warn(`Failed to remove orchestrator labels from #${issueNumber}: ${error.message}`);
        }
    }
    /**
     * Get reviews for a pull request
     * @param prNumber - PR number
     * @returns Array of reviews
     */
    async getPullRequestReviews(prNumber) {
        try {
            const { data } = await this.octokit.rest.pulls.listReviews({
                owner: this.getRepo().owner,
                repo: this.getRepo().repo,
                pull_number: prNumber
            });
            return data.map(review => ({
                id: review.id,
                user: review.user?.login || 'unknown',
                state: review.state,
                body: review.body || '',
                submittedAt: review.submitted_at || ''
            }));
        }
        catch (error) {
            throw new Error(`Failed to get reviews for PR #${prNumber}: ${error.message}`);
        }
    }
    /**
     * Get review comments for a pull request
     * @param prNumber - PR number
     * @returns Array of review comments
     */
    async getPullRequestComments(prNumber) {
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
                inReplyToId: comment.in_reply_to_id ?? null,
                createdAt: comment.created_at
            }));
        }
        catch (error) {
            throw new Error(`Failed to get comments for PR #${prNumber}: ${error.message}`);
        }
    }
    /**
     * Reply to a review comment
     * @param prNumber - PR number
     * @param commentId - Comment ID to reply to
     * @param body - Reply body
     * @returns void
     */
    async replyToReviewComment(prNumber, commentId, body) {
        try {
            await this.octokit.rest.pulls.createReplyForReviewComment({
                owner: this.getRepo().owner,
                repo: this.getRepo().repo,
                pull_number: prNumber,
                comment_id: commentId,
                body
            });
        }
        catch (error) {
            throw new Error(`Failed to reply to comment ${commentId} on PR #${prNumber}: ${error.message}`);
        }
    }
    /**
     * Add a comment to a pull request (not a review comment)
     * @param prNumber - PR number
     * @param body - Comment body
     * @returns void
     */
    async addPullRequestComment(prNumber, body) {
        try {
            await this.octokit.rest.issues.createComment({
                owner: this.getRepo().owner,
                repo: this.getRepo().repo,
                issue_number: prNumber,
                body
            });
        }
        catch (error) {
            throw new Error(`Failed to add comment to PR #${prNumber}: ${error.message}`);
        }
    }
    /**
     * Get all issue-style comments on a PR (general comments, not inline review comments)
     * @param prNumber - PR number
     * @returns Array of comments
     */
    async getPullRequestIssueComments(prNumber) {
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
        }
        catch (error) {
            throw new Error(`Failed to get PR comments: ${error.message}`);
        }
    }
}
//# sourceMappingURL=github.js.map