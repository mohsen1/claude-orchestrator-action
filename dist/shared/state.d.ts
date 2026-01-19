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
export interface OrchestratorConfig {
    version: string;
    config_rotation: {
        current_index: number;
        last_rotation_time: string | null;
    };
}
export declare function readDirectorState(): Promise<DirectorState | null>;
export declare function writeDirectorState(state: DirectorState): Promise<void>;
export declare function readEmState(emId: number): Promise<EMState | null>;
export declare function writeEmState(emId: number, state: EMState): Promise<void>;
export declare function readWorkerState(emId: number, workerId: number): Promise<WorkerState | null>;
export declare function writeWorkerState(emId: number, workerId: number, state: WorkerState): Promise<void>;
export declare function readConfig(): Promise<OrchestratorConfig | null>;
export declare function writeConfig(config: OrchestratorConfig): Promise<void>;
export declare function initConfig(): Promise<OrchestratorConfig>;
//# sourceMappingURL=state.d.ts.map