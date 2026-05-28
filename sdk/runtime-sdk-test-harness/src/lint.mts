export interface HarnessLintFinding {
  readonly code: "raw-date-now" | "raw-math-random";
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export function lintBundleSource(source: string): readonly HarnessLintFinding[] {
  return [
    ...findPattern(source, "Date.now", "raw-date-now", "Use c.now() for deterministic tests."),
    ...findPattern(source, "Math.random", "raw-math-random", "Use c.rng() for deterministic tests."),
  ];
}

export function assertHarnessLintClean(source: string): void {
  const findings = lintBundleSource(source);
  if (findings.length === 0) return;
  throw new Error(
    findings
      .map((finding) => `${finding.code} at ${finding.line}:${finding.column}: ${finding.message}`)
      .join("\n"),
  );
}

function findPattern(
  source: string,
  pattern: string,
  code: HarnessLintFinding["code"],
  message: string,
): readonly HarnessLintFinding[] {
  const findings: HarnessLintFinding[] = [];
  const lines = source.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    let searchFrom = 0;
    while (searchFrom < line.length) {
      const columnIndex = line.indexOf(pattern, searchFrom);
      if (columnIndex === -1) break;
      findings.push({
        code,
        message,
        line: lineIndex + 1,
        column: columnIndex + 1,
      });
      searchFrom = columnIndex + pattern.length;
    }
  }
  return findings;
}
