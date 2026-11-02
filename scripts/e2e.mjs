import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { E2EError, IsolatedHarness, redact } from '../tests/e2e/harness.mjs';
import { runScenarios } from '../tests/e2e/scenarios.mjs';

export async function runE2E({ reportPath = fileURLToPath(new URL('../.local/e2e-report.json', import.meta.url)) } = {}) {
  const harness = new IsolatedHarness(); const startedAt = new Date().toISOString(); const started = Date.now();
  const report = { version: 1, kind: 'isolated_real_http_e2e', startedAt, liveProviders: false, browserUsed: false, status: 'running', steps: harness.steps };
  const stop = () => { harness.interrupted = true; for (const child of harness.children) harness.signal(child, 'SIGKILL'); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let failure;
  try { await runScenarios(harness); report.status = 'passed'; }
  catch (error) {
    failure = error; report.status = 'failed'; report.errorCode = error.code ?? 'E2E_ASSERTION_FAILED';
    report.error = redact(error.message, harness.secrets).slice(0, 1000);
    report.diagnostics = redact(harness.logs, harness.secrets).slice(-6000);
  } finally {
    try { report.cleanup = await harness.cleanup(); }
    catch (error) {
      failure ??= error; report.status = 'failed'; report.errorCode ??= error.code ?? 'E2E_CLEANUP_FAILED';
      report.error ??= redact(error.message, harness.secrets).slice(0, 1000);
      report.cleanup = { ownedProcessesStopped: false, temporaryDataRemoved: false };
    }
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    report.sourceSnapshotSha256 = harness.sourceHash ?? null;
    report.durationMs = Date.now() - started; report.finishedAt = new Date().toISOString();
    await mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  }
  console.log(`E2E ${report.status}: ${report.steps.filter((step) => step.status === 'passed').length}/${report.steps.length} scenarios; report ${reportPath}`);
  if (failure) throw new E2EError(report.errorCode, report.error);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runE2E().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
