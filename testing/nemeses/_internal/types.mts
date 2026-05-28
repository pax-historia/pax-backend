export type NemesisKind =
  | "no-faults"
  | "shard-death-every-5m"
  | "api-kind-partition-burst";

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
    }
  | {
      readonly type: "api-kind-partition";
      readonly afterMs: number;
      readonly durationMs: number;
      readonly kindName: string;
      readonly partitionUrl: string;
    };
