export type NemesisKind = "no-faults" | "shard-death-every-5m";

export interface NemesisManifest {
  readonly nemesisId: NemesisKind;
  readonly description: string;
  readonly actions: readonly NemesisAction[];
}

export type NemesisAction =
  | {
      readonly type: "none";
    }
  | {
      readonly type: "kill-shard";
      readonly everyMs: number;
      readonly selection: "round-robin" | "least-recently-killed";
      readonly replacement: "let-orchestrator-replace";
    };
