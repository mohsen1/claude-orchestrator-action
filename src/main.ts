import * as core from '@actions/core';
import { run as runDirector } from './director';
import { run as runArchitect } from './architect';
import { run as runWorker } from './worker';
import { run as runReviewer } from './reviewer';

async function run() {
  const role = core.getInput('role');
  console.log(`🤖 Booting Agent with Role: [${role.toUpperCase()}]`);

  try {
    switch (role) {
      case 'director':
        await runDirector();
        break;
      case 'architect':
        await runArchitect();
        break;
      case 'worker':
        await runWorker();
        break;
      case 'reviewer':
        await runReviewer();
        break;
      default:
        throw new Error(`Unknown role: ${role}`);
    }
  } catch (error) {
    const err = error as Error;
    console.error(err);
    core.setFailed(err.message);
  }
}

run();

export { run };
