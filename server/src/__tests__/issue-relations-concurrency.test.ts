import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, issueRelations, issues } from "@paperclipai/db";
import { buildHostServices } from "../services/plugin-host-services.js";
import { issueService } from "../services/issues.js";
import { buildIssueGraphLivenessIncidentKey, RECOVERY_ORIGIN_KINDS } from "../services/recovery/origins.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("atomic issue relation mutations", () => {
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let clients: ReturnType<typeof createDb>[];
  const names = ["relations-writer-a", "relations-writer-b"];

  beforeAll(async () => {
    fixture = await startEmbeddedPostgresTestDatabase("paperclip-relations-concurrency-");
    db = createDb(fixture.connectionString);
    clients = names.map((applicationName) => createDb(fixture.connectionString, { applicationName }));
  }, 20_000);

  afterAll(async () => { await fixture?.cleanup(); });

  function host(index: number) {
    return buildHostServices(clients[index], "relations-test-plugin", "paperclip.relations-test", {
      forPlugin: () => ({ emit: async () => {}, subscribe: () => {} }),
    } as any);
  }

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Relations test", issuePrefix: companyId.slice(0, 6) });
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await db.insert(issues).values(ids.map((id, index) => ({ id, companyId, title: `Issue ${index}`, status: "backlog" })));
    return { companyId, target: ids[0], a: ids[1], b: ids[2] };
  }

  // Both real requests must reach a PostgreSQL lock wait before the barrier is
  // released. This exposes stale read/modify/write without scheduler sleeps.
  async function waitForWriter(index: number) {
    await expect.poll(async () => {
      const rows = await db.execute(sql`select pid from pg_stat_activity
        where application_name = ${names[index]} and wait_event_type = 'Lock'`);
      return rows.length;
    }, { timeout: 5_000 }).toBeGreaterThan(0);
  }

  async function whileTargetLocked(target: string | string[], start: () => Promise<unknown>[] | Promise<Promise<unknown>[]>) {
    let operations: Promise<unknown>[] = [];
    await db.transaction(async (tx) => {
      const targets = Array.isArray(target) ? target : [target];
      await tx.execute(sql`select id from issues where id in (${sql.join(targets.map((id) => sql`${id}`), sql`, `)}) order by id for update`);
      operations = await start();
      try {
        await expect.poll(async () => {
          const rows = await db.execute(sql`select application_name from pg_stat_activity
            where application_name in (${names[0]}, ${names[1]}) and wait_event_type = 'Lock'`);
          return new Set(rows.map((row) => row.application_name)).size;
        }, { timeout: 5_000 }).toBe(2);
      } catch (error) {
        void Promise.allSettled(operations);
        throw error;
      }
    });
    return Promise.allSettled(operations);
  }

  it("retains both concurrent plugin additions instead of replacing a stale blocker set", async () => {
    const { companyId, target, a, b } = await seed();
    const results = await whileTargetLocked(target, () => [
      host(0).issues.addBlockers({ companyId, issueId: target, blockerIssueIds: [a] }),
      host(1).issues.addBlockers({ companyId, issueId: target, blockerIssueIds: [b] }),
    ]);
    expect(results.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);
    const relations = await issueService(db).getRelationSummaries(target);
    expect(relations.blockedBy.map((entry) => entry.id).sort()).toEqual([a, b].sort());
    const activities = await db.select().from(activityLog).where(and(
      eq(activityLog.entityId, target), eq(activityLog.action, "issue.relations.updated"),
    ));
    expect(activities).toHaveLength(2);
    expect(activities.map((entry) => (entry.details as any).blockedByIssueIds.length).sort()).toEqual([1, 2]);
    expect(await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, target))).toHaveLength(2);
  });

  it("rejects one concurrent opposite edge as a cycle instead of deadlocking", async () => {
    const { companyId, a, b } = await seed();
    const results = await whileTargetLocked([a, b], () => [
      host(0).issues.addBlockers({ companyId, issueId: a, blockerIssueIds: [b] }),
      host(1).issues.addBlockers({ companyId, issueId: b, blockerIssueIds: [a] }),
    ]);
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.message).toBe("Blocking relations cannot contain cycles");
    expect(await db.select().from(issueRelations).where(eq(issueRelations.companyId, companyId))).toHaveLength(1);
  });

  it("preserves existing edge attribution on duplicate add and unrelated remove", async () => {
    const { companyId, target, a, b } = await seed();
    await host(0).issues.addBlockers({ companyId, issueId: target, blockerIssueIds: [a], actorUserId: "original-author" });
    const [original] = await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, target));
    await host(1).issues.addBlockers({ companyId, issueId: target, blockerIssueIds: [a, a], actorUserId: "second-author" });
    await host(1).issues.removeBlockers({ companyId, issueId: target, blockerIssueIds: [b], actorUserId: "second-author" });
    expect(await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, target))).toEqual([original]);
  });

  it("preserves both a concurrent removal and an unrelated addition", async () => {
    const { companyId, target, a, b } = await seed();
    await host(0).issues.addBlockers({ companyId, issueId: target, blockerIssueIds: [a] });
    const results = await whileTargetLocked(target, () => [
      host(0).issues.removeBlockers({ companyId, issueId: target, blockerIssueIds: [a] }),
      host(1).issues.addBlockers({ companyId, issueId: target, blockerIssueIds: [b] }),
    ]);
    expect(results.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await issueService(db).getRelationSummaries(target)).blockedBy.map((entry) => entry.id)).toEqual([b]);
  });

  it("increments a blocked target's version and returns authoritative activity for add/remove", async () => {
    const { companyId, target, a, b } = await seed();
    await db.update(issues).set({ status: "blocked", statusVersion: 7, updatedAt: new Date("2000-01-01") }).where(eq(issues.id, target));
    const [before] = await db.select().from(issues).where(eq(issues.id, target));
    await host(0).issues.addBlockers({ companyId, issueId: target, blockerIssueIds: [a, b] });
    await host(0).issues.removeBlockers({ companyId, issueId: target, blockerIssueIds: [a] });
    const [updated] = await db.select().from(issues).where(eq(issues.id, target));
    expect(updated.statusVersion).toBe(before.statusVersion + 2);
    expect(updated.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    const rows = await db.select().from(activityLog).where(and(eq(activityLog.entityId, target), eq(activityLog.action, "issue.relations.updated")));
    const removal = rows.find((row) => row.details?.mutation === "remove");
    expect(removal?.details?.previousBlockedByIssueIds).toEqual([a, b].sort());
    expect(removal?.details?.blockedByIssueIds).toEqual([b]);
  });

  it("rolls back self and cross-company blockers without writing audit activity", async () => {
    const own = await seed();
    const foreign = await seed();
    for (const blocker of [own.target, foreign.a]) {
      await expect(host(0).issues.addBlockers({ companyId: own.companyId, issueId: own.target, blockerIssueIds: [blocker] })).rejects.toThrow();
    }
    await expect(host(0).issues.addBlockers({ companyId: foreign.companyId, issueId: own.target, blockerIssueIds: [foreign.a] })).rejects.toThrow();
    expect(await db.select().from(issueRelations).where(eq(issueRelations.relatedIssueId, own.target))).toHaveLength(0);
    expect(await db.select().from(activityLog).where(eq(activityLog.entityId, own.target))).toHaveLength(0);
  });

  it("serializes add against exact set without losing the requested addition", async () => {
    const { companyId, target, a, b } = await seed();
    const results = await whileTargetLocked(target, () => [
      host(0).issues.addBlockers({ companyId, issueId: target, blockerIssueIds: [a] }),
      issueService(clients[1]).update(target, { blockedByIssueIds: [b], companyGuard: companyId }),
    ]);
    expect(results.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);
    const actual = (await issueService(db).getRelationSummaries(target)).blockedBy.map((entry) => entry.id).sort();
    expect([[b], [a, b].sort()]).toContainEqual(actual);
  });

  it("does not block an unrelated company's mutation behind the graph lock", async () => {
    const first = await seed();
    const other = await seed();
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'issue-relations:' + first.companyId}, 0))`);
      await host(1).issues.addBlockers({ companyId: other.companyId, issueId: other.target, blockerIssueIds: [other.a] });
    });
    expect((await issueService(db).getRelationSummaries(other.target)).blockedBy.map((entry) => entry.id)).toEqual([other.a]);
  });

  for (const setFirst of [true, false]) {
    it(`orders exact set and additive mutation when ${setFirst ? "set" : "add"} reaches the lock first`, async () => {
      const { companyId, target, a, b } = await seed();
      const results = await whileTargetLocked(target, async () => {
        const first = setFirst
          ? issueService(clients[0]).update(target, { blockedByIssueIds: [b], companyGuard: companyId })
          : host(0).issues.addBlockers({ companyId, issueId: target, blockerIssueIds: [a] });
        await waitForWriter(0);
        const second = setFirst
          ? host(1).issues.addBlockers({ companyId, issueId: target, blockerIssueIds: [a] })
          : issueService(clients[1]).update(target, { blockedByIssueIds: [b], companyGuard: companyId });
        return [first, second];
      });
      expect(results.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);
      expect((await issueService(db).getRelationSummaries(target)).blockedBy.map((entry) => entry.id).sort())
        .toEqual(setFirst ? [a, b].sort() : [b]);
    });
  }

  it("coordinates imported edges with a concurrent plugin addition and preserves imported metadata", async () => {
    const { companyId, target, a, b } = await seed();
    const [before] = await db.select().from(issues).where(eq(issues.id, target));
    const results = await whileTargetLocked(target, () => [
      issueService(clients[0]).importBlockedByRelations(companyId, [{ issueId: target, blockerIssueId: a }], "import-author"),
      host(1).issues.addBlockers({ companyId, issueId: target, blockerIssueIds: [b] }),
    ]);
    expect(results.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await issueService(db).getRelationSummaries(target)).blockedBy.map((entry) => entry.id).sort()).toEqual([a, b].sort());
    const [afterPlugin] = await db.select().from(issues).where(eq(issues.id, target));
    const skipped = await issueService(db).importBlockedByRelations(companyId, [{ issueId: a, blockerIssueId: target }], "import-author");
    expect(skipped).toEqual([{ issueId: a, blockerIssueId: target }]);
    await issueService(db).importBlockedByRelations(companyId, [{ issueId: target, blockerIssueId: a }], "another-author");
    const [afterImport] = await db.select().from(issues).where(eq(issues.id, target));
    expect(afterImport.updatedAt).toEqual(afterPlugin.updatedAt);
    expect(afterImport.statusVersion).toBe(before.statusVersion);
    const [edge] = await db.select().from(issueRelations).where(and(eq(issueRelations.relatedIssueId, target), eq(issueRelations.issueId, a)));
    expect(edge.createdByUserId).toBe("import-author");
  });

  it("prunes only terminal recovery blockers while preserving a concurrent plugin addition", async () => {
    const { companyId, target, a, b } = await seed();
    const terminal = [randomUUID(), randomUUID()];
    await db.insert(issues).values(terminal.map((id, index) => ({ id, companyId, title: "Terminal blocker", status: index ? "cancelled" : "done" })));
    await host(0).issues.addBlockers({ companyId, issueId: target, blockerIssueIds: [a, ...terminal] });
    const results = await whileTargetLocked(target, () => [
      issueService(clients[0]).update(target, { companyGuard: companyId, status: "blocked", blockedByIssueIds: [a] }, clients[0], undefined, undefined,
        { blockedByMutation: "add", pruneResolvedBlockers: true }),
      host(1).issues.addBlockers({ companyId, issueId: target, blockerIssueIds: [b] }),
    ]);
    expect(results.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await issueService(db).getRelationSummaries(target)).blockedBy.map((entry) => entry.id).sort()).toEqual([a, b].sort());
  });

  it("does not let add(B) resurrect retained(A) deleted after its receipt snapshot", async () => {
    const { companyId, target, a, b } = await seed();
    await db.update(issues).set({ originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
      originId: buildIssueGraphLivenessIncidentKey({ companyId, issueId: target, state: "blocked" }) }).where(eq(issues.id, a));
    await host(0).issues.addBlockers({ companyId, issueId: target, blockerIssueIds: [a] });
    const results = await whileTargetLocked(a, async () => {
      const deletion = issueService(clients[0]).update(a, { status: "done" });
      await waitForWriter(0);
      return [deletion, host(1).issues.addBlockers({ companyId, issueId: target, blockerIssueIds: [b] })];
    });
    expect(results.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await issueService(db).getRelationSummaries(target)).blockedBy.map((entry) => entry.id)).toEqual([b]);
    const activities = await db.select().from(activityLog).where(and(eq(activityLog.entityId, target), eq(activityLog.action, "issue.relations.updated")));
    const addition = activities.find((entry) => (entry.details?.addedBlockerIssueIds as string[]).includes(b));
    expect(addition?.details).toMatchObject({ blockedByIssueIds: [b], previousBlockedByIssueIds: [a], addedBlockerIssueIds: [b], removedBlockerIssueIds: [] });
    expect((results[1] as PromiseFulfilledResult<{ blockedBy: Array<{ id: string }> }>).value.blockedBy.map((entry) => entry.id)).toEqual([b]);
    // Once deletion has committed, an explicit add(A) is a new requested edge.
    await host(0).issues.addBlockers({ companyId, issueId: target, blockerIssueIds: [a] });
    expect((await issueService(db).getRelationSummaries(target)).blockedBy.map((entry) => entry.id).sort()).toEqual([a, b].sort());
  });

  for (const deleteFirst of [true, false]) {
    it(`does not resurrect retained edges when liveness delete ${deleteFirst ? "waits first" : "waits last"}`, async () => {
      const { companyId, target, a, b } = await seed();
      await db.update(issues).set({ originKind: RECOVERY_ORIGIN_KINDS.issueGraphLivenessEscalation,
        originId: buildIssueGraphLivenessIncidentKey({ companyId, issueId: target, state: "blocked" }) }).where(eq(issues.id, a));
      await host(0).issues.addBlockers({ companyId, issueId: target, blockerIssueIds: [a, b] });
      const results = await whileTargetLocked(a, async () => {
        const first = deleteFirst
          ? issueService(clients[0]).update(a, { status: "done" })
          : issueService(clients[0]).update(target, { blockedByIssueIds: [a, b] });
        await waitForWriter(0);
        const second = deleteFirst
          ? issueService(clients[1]).update(target, { blockedByIssueIds: [a, b] })
          : issueService(clients[1]).update(a, { status: "done" });
        return [first, second];
      });
      expect(results.map((entry) => entry.status)).toEqual(["fulfilled", "fulfilled"]);
      expect((await issueService(db).getRelationSummaries(target)).blockedBy.map((entry) => entry.id).sort())
        .toEqual([b]);
    });
  }
});
