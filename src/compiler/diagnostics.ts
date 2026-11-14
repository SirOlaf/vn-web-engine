export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  readonly severity: DiagnosticSeverity;
  /** Stable identifier of the condition, e.g. the native message name it corresponds to. */
  readonly code: string;
  readonly message: string;
  readonly file: string;
  /** 1-based line, 0 if unknown. */
  readonly line: number;
  readonly column: number;
}

/** Diagnostics of one compilation, in report order. */
export class Diagnostics {
  readonly list: Diagnostic[] = [];
  #errors = 0;

  report(diagnostic: Diagnostic): void {
    this.list.push(diagnostic);
    if (diagnostic.severity === 'error') this.#errors++;
  }

  get errorCount(): number {
    return this.#errors;
  }

  get errors(): Diagnostic[] {
    return this.list.filter((d) => d.severity === 'error');
  }
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.line ? `${d.file}(${d.line}:${d.column})` : d.file;
  return `${where}: ${d.severity} ${d.code}: ${d.message}`;
}
