import * as core from '@actions/core';
import * as github from '@actions/github';
import { getClaudePlan, dispatchWorkflow, getFileTree } from './utils';

async function run() {
  const goal = core.getInput('goal');
  const scopePath = core.getInput('scope_path');
  const currentBranch = github.context.ref?.replace('refs/heads/', '') || 'main';

  const fileTree = await getFileTree(scopePath);

  const prompt = `
    You are a Software Architect responsible for: ${scopePath}.
    GOAL: ${goal}

    Current Files in scope:
    ${fileTree}

    Break this down into atomic coding tasks for developers (Workers).
    Each task should focus on 1-3 files maximum.

    Output JSON:
    {
      "tasks": [
        { "id": "init_server", "description": "Create basic Express app", "files": ["src/api/index.js"] }
      ]
    }
  `;

  const plan = await getClaudePlan(prompt);
  if (!plan?.tasks) return;

  for (const task of plan.tasks) {
    console.log(`Dispatching Worker for: ${task.id}`);

    await dispatchWorkflow({
      role: 'worker',
      goal: task.description,
      parent_branch: currentBranch,
      scope_path: scopePath,
      task_context: JSON.stringify(task),
      branch_ref: currentBranch,
    });
  }
}

export { run };
