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

export type IterTrace = {
  iter: number;
  query: string;
  constraints: string;
  generated: GenerateOut;
  hard: HardValidation;
  evidenceContext: string[];
  judge?: JudgeOut;
  passed: boolean;
};
