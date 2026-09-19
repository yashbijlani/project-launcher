export type HealthCheckType = 'process' | 'tcp' | 'http' | 'command';

export interface HealthCheck {
  type: HealthCheckType;
  /** http: url. tcp: host/port. command: command to run (exit 0 = healthy). */
  url?: string;
  host?: string;
  port?: number;
  command?: string;
  /** How long the check may take before being considered failed, ms. */
  timeoutMs?: number;
  /** Interval between checks, ms. */
  intervalMs?: number;
  /** How long to wait for the service to become healthy before giving up, ms. */
  startPeriodMs?: number;
  /** HTTP status codes considered healthy. Default: 200-399. */
  expectStatus?: number[];
  /** For http: require this substring in the body. */
  expectBody?: string;
}

export type RestartPolicy = 'never' | 'on-failure' | 'always';

export interface Service {
  id: string;
  name: string;
  command: string;
  cwd?: string;
  environment?: Record<string, string>;
  dependsOn?: string[];
  healthCheck?: HealthCheck;
  restartPolicy?: RestartPolicy;
  /** Optional declared port, used for display + implicit tcp health fallback. */
  port?: number;
  /** Marks a service as safe/unsafe to auto-run without explicit user consent. */
  autoStart?: boolean;
  /** Free-form notes surfaced in the UI. */
  notes?: string;
}

export interface Profile {
  services: string[];
  description?: string;
}

export interface Action {
  command: string;
  cwd?: string;
  environment?: Record<string, string>;
  description?: string;
}

export interface ProjectMetadata {
  description?: string;
  discoveredAt?: string;
  /** How the configuration came to be. */
  source?: 'discovery' | 'manual' | 'ai-proposal' | 'learned';
  stack?: string[];
  /** True when discovery flagged this project as unsafe to auto-run. */
  unsafe?: boolean;
  unsafeReason?: string;
}

export interface Project {
  id: string;
  name: string;
  root: string;
  services: Service[];
  profiles?: Record<string, Profile>;
  actions?: Record<string, Action>;
  metadata?: ProjectMetadata;
}

/** Result returned by a detector for a single project root. */
export interface CandidateCommand {
  command: string;
  cwd?: string;
  port?: number;
  /** Which service role this candidate is likely for. */
  role?: string;
  serviceId?: string;
  dependsOn?: string[];
}

export interface Detection {
  type: string;
  confidence: number;
  evidence: string[];
  candidates: CandidateCommand[];
  /** Extra metadata discovered, e.g. package manager, scripts. */
  meta?: Record<string, unknown>;
}

export interface ProjectEvidence {
  name: string;
  root: string;
  topDirs: string[];
  manifests: string[];
  readmeTitle?: string;
  /** Bounded README excerpt, not the whole file. */
  readmeExcerpt?: string;
  signals: Record<string, unknown>;
  detections: Detection[];
  failedAttempts?: FailedAttempt[];
  logs?: string[];
}

export interface FailedAttempt {
  command: string;
  cwd?: string;
  exitCode?: number;
  failureClass: FailureClass;
  stderrExcerpt?: string;
}

export type FailureClass =
  | 'COMMAND_UNKNOWN'
  | 'WRONG_WORKING_DIRECTORY'
  | 'WRONG_MODULE_PATH'
  | 'MISSING_DEPENDENCY'
  | 'MISSING_ENVIRONMENT_VARIABLE'
  | 'PORT_CONFLICT'
  | 'WRONG_PACKAGE_MANAGER'
  | 'PYTHON_ENVIRONMENT'
  | 'NODE_VERSION'
  | 'DATABASE_REQUIRED'
  | 'SERVICE_ORDER'
  | 'DOCKER_REQUIRED'
  | 'DEVICE_REQUIRED'
  | 'GPU_REQUIRED'
  | 'PERMISSION'
  | 'CUSTOM_SCRIPT'
  | 'AMBIGUOUS'
  | 'UNKNOWN';

export interface ProjectProposal {
  project: Project;
  confidence: number;
  rationale: string;
  warnings: string[];
}

export interface IntelligentDiscoveryProvider {
  readonly id: string;
  analyzeProject(input: ProjectEvidence): Promise<ProjectProposal>;
}

export type ServiceStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'healthy'
  | 'unhealthy'
  | 'crashed'
  | 'stopping'
  | 'failed';

export interface RuntimeServiceState {
  id: string;
  status: ServiceStatus;
  pid?: number;
  startedAt?: number;
  stoppedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  restarts: number;
  health?: {
    status: 'unknown' | 'healthy' | 'unhealthy';
    lastCheckAt?: number;
    detail?: string;
  };
}

export interface RuntimeProjectState {
  projectId: string;
  name: string;
  startedAt?: number;
  services: Record<string, RuntimeServiceState>;
}
