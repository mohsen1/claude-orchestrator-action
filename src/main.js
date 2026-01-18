const core = require('@actions/core');
const director = require('./director');
const architect = require('./architect');
const worker = require('./worker');
const reviewer = require('./reviewer');

async function run() {
  const role = core.getInput('role');
  console.log(`🤖 Booting Agent with Role: [${role.toUpperCase()}]`);

  try {
    switch (role) {
      case 'director':
        await director.run();
        break;
      case 'architect':
        await architect.run();
        break;
      case 'worker':
        await worker.run();
        break;
      case 'reviewer':
        await reviewer.run();
        break;
      default:
        throw new Error(`Unknown role: ${role}`);
    }
  } catch (error) {
    console.error(error);
    core.setFailed(error.message);
  }
}

run();

module.exports = { run };
