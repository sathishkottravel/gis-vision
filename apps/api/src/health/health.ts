export type DependencyName = 'database' | 'objectStorage';
export type CheckStatus = 'ok' | 'error';

/** A single readiness probe for one dependency. Throwing or rejecting means unhealthy. */
export interface HealthCheck {
  readonly name: DependencyName;
  check(signal: AbortSignal): Promise<void>;
}

export type HealthReport = { status: CheckStatus } & Record<DependencyName, CheckStatus>;

export interface CheckFailure {
  name: DependencyName;
  error: unknown;
}

class CheckTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`health check timed out after ${String(timeoutMs)}ms`);
    this.name = 'CheckTimeoutError';
  }
}

async function runWithTimeout(check: HealthCheck, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new CheckTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    await Promise.race([check.check(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs all checks in parallel, each bounded by `timeoutMs`, so a hung dependency
 * cannot hang the caller. Failures are returned separately for logging; the report
 * itself contains only status values.
 */
export async function runHealthChecks(
  checks: readonly HealthCheck[],
  timeoutMs: number,
): Promise<{ report: HealthReport; failures: CheckFailure[] }> {
  const results = await Promise.allSettled(checks.map((c) => runWithTimeout(c, timeoutMs)));

  const report: HealthReport = { status: 'ok', database: 'ok', objectStorage: 'ok' };
  const failures: CheckFailure[] = [];
  results.forEach((result, index) => {
    const check = checks[index];
    if (check && result.status === 'rejected') {
      report[check.name] = 'error';
      report.status = 'error';
      failures.push({ name: check.name, error: result.reason });
    }
  });
  return { report, failures };
}
