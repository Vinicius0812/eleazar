import { describe, expect, it } from "vitest";
import { createMockControlRoomClient } from "./mock-client.js";
describe("mock control room boundary", () => {
  it("isolates snapshots and client instances", async () => {
    const first = createMockControlRoomClient();
    const second = createMockControlRoomClient();
    const snapshot = await first.getSnapshot();
    snapshot.projects.splice(0);
    expect((await first.getSnapshot()).projects).toHaveLength(3);
    await first.registerProject({ name: "Novo", path: "/work/novo" });
    expect((await second.getSnapshot()).projects).toHaveLength(3);
  });
  it("validates paths and rejects equivalent duplicate paths", async () => {
    const client = createMockControlRoomClient();
    await expect(
      client.registerProject({ name: "Novo", path: "relative/path" }),
    ).rejects.toThrow("absoluto");
    await expect(
      client.registerProject({
        name: "Duplicado",
        path: "c:/projetos/eleazar/",
      }),
    ).rejects.toThrow("já está cadastrado");
    expect((await client.getSnapshot()).projects).toHaveLength(3);
  });
  it("queues typed tasks without creating runs, preserving prompt as text", async () => {
    const client = createMockControlRoomClient();
    const prompt = "<script>alert(1)</script> $() `literal`";
    const task = await client.createTask({
      projectId: "eleazar",
      title: "  Contratos  ",
      prompt,
      priority: "high",
    });
    expect(task).toMatchObject({
      title: "Contratos",
      prompt,
      status: "queued",
      priority: "high",
    });
    const state = await client.getSnapshot();
    expect(state.runs).toHaveLength(2);
    expect(state.tasks).toContainEqual(task);
    expect(state.logs[0]?.message).toContain("Contratos");
  });
  it("rejects missing projects and empty prompts without changing state", async () => {
    const client = createMockControlRoomClient();
    await expect(
      client.createTask({
        projectId: "missing",
        title: "Task",
        prompt: "Prompt",
        priority: "normal",
      }),
    ).rejects.toThrow("projeto");
    await expect(
      client.createTask({
        projectId: "eleazar",
        title: "Task",
        prompt: " ",
        priority: "normal",
      }),
    ).rejects.toThrow("prompt");
    expect((await client.getSnapshot()).tasks).toHaveLength(6);
  });
  it.each(["approve", "reject"] as const)(
    "records %s once, updates task and removes approval alert",
    async (decision) => {
      const client = createMockControlRoomClient();
      await client.decideApproval("APR-12", decision);
      const state = await client.getSnapshot();
      expect(state.tasks.find((task) => task.id === "TSK-102")?.status).toBe(
        decision === "approve" ? "queued" : "blocked",
      );
      expect(state.approvals).toHaveLength(0);
      expect(state.alerts.map((alert) => alert.id)).not.toContain("ALT-1");
      expect(state.runs).toHaveLength(2);
      await expect(client.decideApproval("APR-12", decision)).rejects.toThrow(
        "pendente",
      );
    },
  );
});
