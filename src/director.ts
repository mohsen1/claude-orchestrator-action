import * as core from '@actions/core';
import { getClaudePlan, dispatchWorkflow, createBranch } from './utils';

function sanitizeBranchName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

async function run() {
  const goal = core.getInput('goal');

  const prompt = `
    You are the CTO/Director.
    GOAL: ${goal}

    Analyze the request. Break this into 2-4 major architectural subsystems (e.g., Frontend, Backend, Database, CI/CD).
    Assign a directory path to each.

    Output JSON:
    {
      "subsystems": [
        { "name": "backend", "goal": "Setup Node.js Express server", "path": "src/api" },
        { "name": "frontend", "goal": "Setup React scaffold", "path": "src/web" }
      ]
    }
  `;

  const plan = await getClaudePlan(prompt);
  if (!plan?.subsystems) return;

  for (const system of plan.subsystems) {
    const sanitizedName = sanitizeBranchName(system.name);
    const branchName = `feature/${sanitizedName}`;
    console.log(`Creating subsystem branch: ${branchName}`);
    await createBranch(branchName, 'main');

    console.log(`Hiring Architect for: ${system.name}`);
    await dispatchWorkflow({
      role: 'architect',
      goal: system.goal,
      parent_branch: 'main',
      scope_path: system.path,
      branch_ref: branchName,
    });
  }
}

export { run };
