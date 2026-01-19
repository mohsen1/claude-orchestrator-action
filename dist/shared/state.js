import fs from 'fs/promises';
import path from 'path';
const ORCHESTRATOR_DIR = '.orchestrator';
// State file paths
function getDirectorStatePath() {
    return path.join(ORCHESTRATOR_DIR, 'director.json');
}
function getEMStatePath(emId) {
    return path.join(ORCHESTRATOR_DIR, `em-${emId}`, `status-em${emId}.json`);
}
function getWorkerStatePath(emId, workerId) {
    return path.join(ORCHESTRATOR_DIR, `em-${emId}`, `worker-${workerId}`, `status-em${emId}-w${workerId}.json`);
}
function getConfigPath() {
    return path.join(ORCHESTRATOR_DIR, 'config.json');
}
// Ensure directory exists
async function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    // fs.mkdir with recursive: true is safe to call even if directory exists
    await fs.mkdir(dir, { recursive: true });
}
// Director state operations
export async function readDirectorState() {
    try {
        const filePath = getDirectorStatePath();
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw new Error(`Failed to read director state: ${error.message}`);
    }
}
export async function writeDirectorState(state) {
    try {
        const filePath = getDirectorStatePath();
        await ensureDir(filePath);
        await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
    }
    catch (error) {
        throw new Error(`Failed to write director state: ${error.message}`);
    }
}
// EM state operations
export async function readEmState(emId) {
    try {
        const filePath = getEMStatePath(emId);
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw new Error(`Failed to read EM-${emId} state: ${error.message}`);
    }
}
export async function writeEmState(emId, state) {
    try {
        const filePath = getEMStatePath(emId);
        await ensureDir(filePath);
        await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
    }
    catch (error) {
        throw new Error(`Failed to write EM-${emId} state: ${error.message}`);
    }
}
// Worker state operations
export async function readWorkerState(emId, workerId) {
    try {
        const filePath = getWorkerStatePath(emId, workerId);
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw new Error(`Failed to read worker EM-${emId}-W${workerId} state: ${error.message}`);
    }
}
export async function writeWorkerState(emId, workerId, state) {
    try {
        const filePath = getWorkerStatePath(emId, workerId);
        await ensureDir(filePath);
        await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
    }
    catch (error) {
        throw new Error(`Failed to write worker EM-${emId}-W${workerId} state: ${error.message}`);
    }
}
// Config operations
export async function readConfig() {
    try {
        const filePath = getConfigPath();
        const content = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(content);
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw new Error(`Failed to read config: ${error.message}`);
    }
}
export async function writeConfig(config) {
    try {
        const filePath = getConfigPath();
        await ensureDir(filePath);
        await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
    }
    catch (error) {
        throw new Error(`Failed to write config: ${error.message}`);
    }
}
// Initialize config if not exists
export async function initConfig() {
    const existing = await readConfig();
    if (existing) {
        return existing;
    }
    const newConfig = {
        version: '1.0',
        config_rotation: {
            current_index: 0,
            last_rotation_time: null
        }
    };
    await writeConfig(newConfig);
    return newConfig;
}
//# sourceMappingURL=state.js.map