export type GenerateOut = {
  answer: string;
  evidence: string[];
};

export type HardValidation = {
  ok: boolean;
  issues: string[];
};

export type JudgeOut = {
  ok: "yes" | "no";
  issues: string[];
};

export type WorkerStepRecord = {
  stepIndex: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type WorkerError = {
  tag: "max-steps-reached";
  message: string;
  stepsCompleted: number;
  maxSteps: number;
  totalTokensUsed: number;
  suggestions: string[];
  steps: WorkerStepRecord[];
};

export type IterTrace = {
  iter: number;
  query: string;
  constraints: string;
  generated: GenerateOut;
  hard: HardValidation;
  evidenceContext: string[];
  judge?: JudgeOut;
  passed: boolean;
  workerError?: WorkerError;
};
