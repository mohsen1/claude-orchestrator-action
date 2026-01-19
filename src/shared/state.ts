import fs from 'fs/promises';
import path from 'path';

const ORCHESTRATOR_DIR = '.orchestrator';

// Director state structure
export interface DirectorState {
  version: string;
  issue_number: number;
  work_branch: string;
  status: 'pending' | 'in_progress' | 'complete' | 'failed';
  created_at: string;
  updated_at: string;
  session_id: string | null;
  task_breakdown: EMTaskBreakdown[];
  final_pr_number: number | null;
}

export interface EMTaskBreakdown {
  em_id: number;
  task: string;
  status: 'pending' | 'in_progress' | 'complete' | 'failed';
}

// EM state structure
export interface EMState {
  em_id: number;
  status: 'pending' | 'in_progress' | 'complete' | 'failed';
  session_id: string | null;
  branch: string;
  pr_number: number | null;
  updated_at: string;
  task_assignment: string;
  changes_summary: string;
  files_modified: string[];
  workers: WorkerTaskBreakdown[];
}

export interface WorkerTaskBreakdown {
  worker_id: number;
  task: string;
  status: 'pending' | 'in_progress' | 'complete' | 'failed';
}

// Worker state structure
export interface WorkerState {
  worker_id: number;
  em_id: number;
  status: 'pending' | 'in_progress' | 'complete' | 'failed';
  session_id: string | null;
  branch: string;
  pr_number: number | null;
  updated_at: string;
  task_assignment: string;
  changes_summary: string;
  files_modified: string[];
  retry_count: number;
}

// Shared config structure
export interface OrchestratorConfig {
  version: string;
  config_rotation: {
    current_index: number;
    last_rotation_time: string | null;
  };
}

// State file paths
function getDirectorStatePath(): string {
  return path.join(ORCHESTRATOR_DIR, 'director.json');
}

function getEMStatePath(emId: number): string {
  return path.join(ORCHESTRATOR_DIR, `em-${emId}`, `status-em${emId}.json`);
}

function getWorkerStatePath(emId: number, workerId: number): string {
  return path.join(ORCHESTRATOR_DIR, `em-${emId}`, `worker-${workerId}`, `status-em${emId}-w${workerId}.json`);
}

function getConfigPath(): string {
  return path.join(ORCHESTRATOR_DIR, 'config.json');
}

// Ensure directory exists
async function ensureDir(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  // fs.mkdir with recursive: true is safe to call even if directory exists
  await fs.mkdir(dir, { recursive: true });
}

// Director state operations
export async function readDirectorState(): Promise<DirectorState | null> {
  try {
    const filePath = getDirectorStatePath();
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as DirectorState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to read director state: ${(error as Error).message}`);
  }
}

export async function writeDirectorState(state: DirectorState): Promise<void> {
  try {
    const filePath = getDirectorStatePath();
    await ensureDir(filePath);
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    throw new Error(`Failed to write director state: ${(error as Error).message}`);
  }
}

// EM state operations
export async function readEmState(emId: number): Promise<EMState | null> {
  try {
    const filePath = getEMStatePath(emId);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as EMState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to read EM-${emId} state: ${(error as Error).message}`);
  }
}

export async function writeEmState(emId: number, state: EMState): Promise<void> {
  try {
    const filePath = getEMStatePath(emId);
    await ensureDir(filePath);
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    throw new Error(`Failed to write EM-${emId} state: ${(error as Error).message}`);
  }
}

// Worker state operations
export async function readWorkerState(emId: number, workerId: number): Promise<WorkerState | null> {
  try {
    const filePath = getWorkerStatePath(emId, workerId);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as WorkerState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to read worker EM-${emId}-W${workerId} state: ${(error as Error).message}`);
  }
}

export async function writeWorkerState(emId: number, workerId: number, state: WorkerState): Promise<void> {
  try {
    const filePath = getWorkerStatePath(emId, workerId);
    await ensureDir(filePath);
    await fs.writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    throw new Error(`Failed to write worker EM-${emId}-W${workerId} state: ${(error as Error).message}`);
  }
}

// Config operations
export async function readConfig(): Promise<OrchestratorConfig | null> {
  try {
    const filePath = getConfigPath();
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as OrchestratorConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw new Error(`Failed to read config: ${(error as Error).message}`);
  }
}

export async function writeConfig(config: OrchestratorConfig): Promise<void> {
  try {
    const filePath = getConfigPath();
    await ensureDir(filePath);
    await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (error) {
    throw new Error(`Failed to write config: ${(error as Error).message}`);
  }
}

// Initialize config if not exists
export async function initConfig(): Promise<OrchestratorConfig> {
  const existing = await readConfig();
  if (existing) {
    return existing;
  }

  const newConfig: OrchestratorConfig = {
    version: '1.0',
    config_rotation: {
      current_index: 0,
      last_rotation_time: null
    }
  };

  await writeConfig(newConfig);
  return newConfig;
}
