/**
 * Watchdog component
 * Detects and recovers from stalled orchestration components
 */

import { GitHubClient } from '../shared/github.js';
import {
  readDirectorState,
  readEmState,
  readWorkerState,
} from '../shared/state.js';

// Stalled component info
export interface StalledComponent {
  type: 'director' | 'em' | 'worker';
  issueNumber: number;
  emId?: number;
  workerId?: number;
  status: string;
  lastUpdated: string;
  stalledMinutes: number;
}

// Watchdog context
export interface WatchdogContext {
  repo: {
    owner: string;
    repo: string;
  };
  token: string;
  stallTimeoutMinutes: number;
}

/**
 * Watchdog class
 */
export class Watchdog {
  private context: WatchdogContext;
  private github: GitHubClient;

  constructor(context: WatchdogContext) {
    this.context = context;
    this.github = new GitHubClient(context.token, context.repo);
  }

  /**
   * Check for stalled components and take action
   */
  async checkStalled(): Promise<StalledComponent[]> {
    console.log('Checking for stalled components...');

    const stalled: StalledComponent[] = [];

    try {
      // Get all issues with orchestrator label
      const issues = await this.github.listIssuesByLabel('orchestrator', 'open');

      console.log(`Found ${issues.length} open orchestration issues`);

      for (const issue of issues) {
        // Check each issue for stalled components
        const issueStalled = await this.checkIssue(issue.number);

        if (issueStalled.length > 0) {
          stalled.push(...issueStalled);

          // Add stalled label and comment
          await this.markIssueStalled(issue.number, issueStalled);
        }
      }

      console.log(`Found ${stalled.length} stalled components`);

      return stalled;
    } catch (error) {
      console.error('Watchdog check failed:', error);
      throw error;
    }
  }

  /**
   * Check a specific issue for stalled components
   */
  private async checkIssue(issueNumber: number): Promise<StalledComponent[]> {
    const stalled: StalledComponent[] = [];
    const now = Date.now();
    const timeoutMs = this.context.stallTimeoutMinutes * 60 * 1000;

    // Check Director state
    try {
      const directorState = await readDirectorState();

      if (directorState && directorState.issue_number === issueNumber) {
        const lastUpdate = new Date(directorState.updated_at).getTime();
        const stalledMs = now - lastUpdate;

        if (stalledMs > timeoutMs && directorState.status === 'in_progress') {
          stalled.push({
            type: 'director',
            issueNumber,
            status: directorState.status,
            lastUpdated: directorState.updated_at,
            stalledMinutes: Math.floor(stalledMs / 60000)
          });
        }
      }
    } catch (error) {
      console.error('Failed to read Director state:', error);
    }

    // Check EM states
    for (let emId = 1; emId <= 10; emId++) {
      try {
        const emState = await readEmState(emId);

        if (emState) {
          const lastUpdate = new Date(emState.updated_at).getTime();
          const stalledMs = now - lastUpdate;

          if (
            stalledMs > timeoutMs &&
            (emState.status === 'in_progress' || emState.status === 'pending')
          ) {
            stalled.push({
              type: 'em',
              issueNumber,
              emId,
              status: emState.status,
              lastUpdated: emState.updated_at,
              stalledMinutes: Math.floor(stalledMs / 60000)
            });
          }

          // Check Workers for this EM
          for (let workerId = 1; workerId <= 10; workerId++) {
            try {
              const workerState = await readWorkerState(emId, workerId);

              if (workerState) {
                const workerLastUpdate = new Date(workerState.updated_at).getTime();
                const workerStalledMs = now - workerLastUpdate;

                if (
                  workerStalledMs > timeoutMs &&
                  (workerState.status === 'in_progress' || workerState.status === 'pending')
                ) {
                  stalled.push({
                    type: 'worker',
                    issueNumber,
                    emId,
                    workerId,
                    status: workerState.status,
                    lastUpdated: workerState.updated_at,
                    stalledMinutes: Math.floor(workerStalledMs / 60000)
                  });
                }
              }
            } catch (error) {
              // Worker state may not exist, continue
            }
          }
        }
      } catch (error) {
        // EM state may not exist, continue
      }
    }

    return stalled;
  }

  /**
   * Mark an issue as stalled with labels and comments
   */
  private async markIssueStalled(
    issueNumber: number,
    stalled: StalledComponent[]
  ): Promise<void> {
    try {
      // Add stalled label
      await this.github.addLabels(issueNumber, ['orchestrator-stalled']);

      // Post comment with details
      const comment = this.buildStalledComment(stalled);
      await this.github.updateIssueComment(issueNumber, comment);
    } catch (error) {
      console.error('Failed to mark issue as stalled:', error);
    }
  }

  /**
   * Build a comment about stalled components
   */
  private buildStalledComment(stalled: StalledComponent[]): string {
    let markdown = '## ⚠️ Orchestration Stalled\n\n';
    markdown += 'The following components have been stalled for over ';
    markdown += `${this.context.stallTimeoutMinutes} minutes:\n\n`;

    for (const component of stalled) {
      markdown += `### ${this.componentDescription(component)}\n`;
      markdown += `- **Status:** ${component.status}\n`;
      markdown += `- **Last Updated:** ${component.lastUpdated}\n`;
      markdown += `- **Stalled For:** ${component.stalledMinutes} minutes\n\n`;
    }

    markdown += '---\n\n';
    markdown += '*This message was automatically generated by the orchestrator watchdog.*';

    return markdown;
  }

  /**
   * Get a human-readable description of a component
   */
  private componentDescription(component: StalledComponent): string {
    switch (component.type) {
      case 'director':
        return 'Director';

      case 'em':
        return `EM-${component.emId}`;

      case 'worker':
        return `Worker EM-${component.emId}-W${component.workerId}`;

      default:
        return 'Unknown';
    }
  }

  /**
   * Attempt to recover a stalled component
   */
  async recoverStalled(component: StalledComponent): Promise<boolean> {
    console.log('Attempting to recover stalled component:', component);

    try {
      switch (component.type) {
        case 'director':
          return await this.recoverDirector(component);

        case 'em':
          return await this.recoverEM(component);

        case 'worker':
          return await this.recoverWorker(component);

        default:
          return false;
      }
    } catch (error) {
      console.error('Failed to recover component:', error);
      return false;
    }
  }

  /**
   * Recover a stalled Director
   */
  private async recoverDirector(component: StalledComponent): Promise<boolean> {
    // Re-trigger the Director workflow
    await this.github.dispatchWorkflow('cco-director.yml', 'main', {
      issue_number: component.issueNumber.toString(),
      resume: 'true'
    });

    console.log('Director recovery triggered');
    return true;
  }

  /**
   * Recover a stalled EM
   */
  private async recoverEM(component: StalledComponent): Promise<boolean> {
    if (component.emId === undefined) {
      return false;
    }

    // Get Director state to find work branch
    const directorState = await readDirectorState();
    if (!directorState) {
      console.error('Cannot recover EM: Director state not found');
      return false;
    }

    // Re-trigger the EM workflow
    await this.github.dispatchWorkflow('cco-em.yml', directorState.work_branch, {
      issue_number: component.issueNumber.toString(),
      em_id: component.emId.toString(),
      task_assignment: 'Resume work',
      work_branch: directorState.work_branch,
      resume: 'true'
    });

    console.log(`EM-${component.emId} recovery triggered`);
    return true;
  }

  /**
   * Recover a stalled Worker
   */
  private async recoverWorker(component: StalledComponent): Promise<boolean> {
    if (component.emId === undefined || component.workerId === undefined) {
      return false;
    }

    // Get EM state to find EM branch
    const emState = await readEmState(component.emId);
    if (!emState) {
      console.error('Cannot recover Worker: EM state not found');
      return false;
    }

    // Re-trigger the Worker workflow
    await this.github.dispatchWorkflow('cco-worker.yml', emState.branch, {
      issue_number: component.issueNumber.toString(),
      em_id: component.emId.toString(),
      worker_id: component.workerId.toString(),
      task_assignment: 'Resume work',
      em_branch: emState.branch,
      resume: 'true'
    });

    console.log(`Worker EM-${component.emId}-W${component.workerId} recovery triggered`);
    return true;
  }
}
