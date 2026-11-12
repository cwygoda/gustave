export const conventionalSubject: RegExp;
export const forbiddenLinePatterns: RegExp[];
export const allowedTypes: string;

export type CommitCheck =
  | { ok: true }
  | { ok: false; kind: "subject"; subject: string }
  | { ok: false; kind: "attribution"; line: string };

export function checkCommitMessage(raw: string): CommitCheck;
