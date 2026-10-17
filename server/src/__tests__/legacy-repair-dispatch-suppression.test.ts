import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  agents, agentWakeupRequests, companies, createDb, environmentLeases,
  heartbeatRuns, issueRecoveryActions, issues, projects, projectWorkspaces,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  dispatchBlock: vi.fn<(runId: string) => Promise<string | null>>(),
  captureRunFailure: vi.fn(),
}));
vi.mock("../adapters/index.js", () => ({
  getServerAdapter: () => ({ type: "codex_local", execute: mocks.execute, supportsLocalAgentJwt: false }),
  findActiveServerAdapter: () => ({ type: "codex_local", execute: mocks.execute, supportsLocalAgentJwt: false }),
  runningProcesses: new Map(),
}));
vi.mock("../services/recovery/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/recovery/service.js")>();
  return { ...actual, recoveryService: (...args: Parameters<typeof actual.recoveryService>) => ({
    ...actual.recoveryService(...args), legacyRepairDispatchBlock: mocks.dispatchBlock,
  }) };
});
vi.mock("../sentry.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../sentry.js")>(), captureRunFailure: mocks.captureRunFailure,
}));

import { heartbeatService } from "../services/heartbeat.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { isUnexpectedRunCancellation } from "../services/run-cancellation.js";
import { legacyExecutionNeedsReconciliation } from "../services/legacy-execution-recovery.js";
import { settleUnrecoverableExecutions } from "../services/execution-recovery-resolution.js";
import { waitForPendingRunFailureReports } from "../services/run-failure-report.js";

describe("legacy repair suppression before provider dispatch", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("legacy-repair-dispatch-");
    db = createDb(temporary.connectionString);
    await instanceSettingsService(db).updateExperimental({ enableNativeRunner: false });
  }, 30_000);
  beforeEach(() => { vi.clearAllMocks(); mocks.dispatchBlock.mockResolvedValue(null); });
  afterAll(async () => {
    if (db) {
      await drainHeartbeatRunsToQuiescence(db, heartbeatService(db));
      await db.$client.end({ timeout: 0 });
    }
    await temporary?.cleanup();
  });

  async function fixture() {
    const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID();
    const projectWorkspaceId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Repair dispatch", issuePrefix: `R${companyId.slice(0, 6)}`, defaultResponsibleUserId: "fixture-owner" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project", status: "active" });
    await db.insert(projectWorkspaces).values({ id: projectWorkspaceId, companyId, projectId, name: "Primary", isPrimary: true, cwd: fileURLToPath(new URL("../../../", import.meta.url)) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Owner", adapterType: "codex_local", status: "idle", runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } } });
    await db.insert(issues).values({ id: issueId, companyId, projectId, projectWorkspaceId, title: "Parent owned by a workflow", status: "in_progress", workMode: "standard", assigneeAgentId: agentId, responsibleUserId: "fixture-owner" });
    mocks.execute.mockImplementation(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
      return { exitCode: 0, signal: null, timedOut: false, resultJson: { summary: "Finished" } };
    });
    const heartbeat = heartbeatService(db);
    const start = async () => {
      const queued = await heartbeat.wakeup(agentId, {
        source: "automation", triggerDetail: "system", reason: "issue_commented", payload: { issueId },
        contextSnapshot: { issueId, taskId: issueId, skipIssueComment: true },
      });
      expect(queued).not.toBeNull();
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      await waitForPendingRunFailureReports();
      return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, queued!.id)))[0];
    };
    return { companyId, agentId, issueId, start };
  }

  it.each(["owned_lifecycle", "invalid_repair_binding", "missing_issue"])("records %s as expected bootstrap cancellation without a recovery hold", async (reason) => {
    const f = await fixture();
    mocks.dispatchBlock.mockResolvedValue(reason);
    const run = await f.start();
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.dispatchBlock).toHaveBeenCalledExactlyOnceWith(run.id);
    expect(run).toMatchObject({ status: "cancelled", errorCode: "legacy_disposition_repair_suppressed", processPid: null,
      resultJson: {
        cancellation: { source: "control_plane", expected: true, initiator: { type: "system" }, reason: `Disposition repair suppressed: ${reason}` },
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      },
    });
    expect(run.resultJson?.cancellation).toMatchObject({ recordedAt: run.finishedAt!.toISOString() });
    expect(isUnexpectedRunCancellation(run)).toBe(false);
    expect(legacyExecutionNeedsReconciliation(run)).toBe(false);
    expect(mocks.captureRunFailure).not.toHaveBeenCalled();
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
    await settleUnrecoverableExecutions(db);
    expect((await db.select().from(issues).where(eq(issues.id, f.issueId)))[0]).toMatchObject({ status: "in_progress", executionRunId: null, checkoutRunId: null });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, f.companyId))).toHaveLength(1);
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run.wakeupRequestId!)))[0].status).toBe("skipped");
    for (const lease of await db.select().from(environmentLeases).where(eq(environmentLeases.companyId, f.companyId))) {
      expect(lease.releasedAt).not.toBeNull();
      expect(lease.cleanupStatus).not.toBe("failed");
    }
  });

  it("does not overwrite a competing terminal result or release its wake twice", async () => {
    const f = await fixture();
    const winner = { summary: "Another controller settled this run" };
    mocks.dispatchBlock.mockImplementation(async (runId) => {
      const [run] = await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date(), resultJson: winner }).where(eq(heartbeatRuns.id, runId)).returning();
      await db.update(agentWakeupRequests).set({ status: "completed" }).where(eq(agentWakeupRequests.id, run.wakeupRequestId!));
      return "owned_lifecycle";
    });
    const run = await f.start();
    expect(run).toMatchObject({ status: "succeeded", resultJson: winner, errorCode: null });
    expect(run.resultJson).not.toHaveProperty("cancellation");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, run.wakeupRequestId!)))[0].status).toBe("completed");
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
  });

  it("dispatches exactly once when the guard admits the run", async () => {
    const f = await fixture();
    const run = await f.start();
    expect(run.status).toBe("succeeded");
    expect(mocks.execute).toHaveBeenCalledOnce();
    expect(run.resultJson).not.toHaveProperty("cancellation");
  });
});
