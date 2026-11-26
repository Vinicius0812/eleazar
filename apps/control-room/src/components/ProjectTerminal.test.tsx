import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ControlRoomClient, Project, TerminalEvent, TerminalSession, TerminalStreamOptions } from "../services/contracts.js";
import { ProjectTerminal } from "./ProjectTerminal.js";

afterEach(cleanup);

const project: Project = { id: "p", name: "Projeto", path: "C:\\p", isolation: "worktree", createdAt: "2026-01-01T00:00:00.000Z",
  directories: [{ id: "d", name: "Principal", path: "C:\\p", createdAt: "2026-01-01T00:00:00.000Z", isGitRepository: true }] };
const session: TerminalSession = { id: "s", projectId: "p", directoryId: "d", root: "C:\\p", cwd: "C:\\p", shell: "bash", startedAt: "2026-01-01T00:00:00.000Z", busy: false, exitCode: null, closed: false };

function fakeClient() {
  let push: ((event: TerminalEvent) => void) | null = null;
  let sequence = 0;
  const emit = (event: Omit<TerminalEvent, "sessionId" | "sequence" | "id" | "createdAt">) => { sequence += 1; push?.({ ...event, sessionId: "s", sequence, id: `s:${sequence}`, createdAt: "now" }); };
  const client = {
    listTerminals: vi.fn(async () => [] as TerminalSession[]),
    openTerminal: vi.fn(async () => session),
    closeTerminal: vi.fn(async () => ({ ...session, closed: true })),
    sendTerminalInput: vi.fn(async (_id: string, command: string) => {
      emit({ kind: "input", text: command });
      emit({ kind: "stdout", text: "ola\n" });
      emit({ kind: "done", exitCode: command === "false" ? 1 : 0, cwd: "C:/p/sub" });
      return session;
    }),
    streamTerminalEvents: vi.fn((_id: string, options: TerminalStreamOptions) => new Promise<boolean>((resolve) => {
      push = options.onEvent;
      options.signal.addEventListener("abort", () => resolve(false));
    })),
  };
  return client as unknown as ControlRoomClient & typeof client;
}

describe("ProjectTerminal", () => {
  it("opens a shell in the project folder, runs commands and recalls them with the arrow keys", async () => {
    const client = fakeClient();
    const user = userEvent.setup();
    render(<ProjectTerminal client={client} project={project} />);
    await waitFor(() => expect(client.openTerminal).toHaveBeenCalledWith("p", "d"));
    const input = await screen.findByLabelText("Comando");
    await waitFor(() => expect(input).toBeEnabled());
    await waitFor(() => expect(client.streamTerminalEvents).toHaveBeenCalled());
    await user.type(input, "cat leia.txt{Enter}");
    expect(client.sendTerminalInput).toHaveBeenCalledWith("s", "cat leia.txt");
    const log = screen.getByRole("log", { name: "Saída do terminal" });
    await waitFor(() => expect(log).toHaveTextContent("$ cat leia.txt"));
    expect(log).toHaveTextContent("ola");
    expect(screen.getByText("C:/p/sub")).toBeInTheDocument();
    await user.type(input, "false{Enter}");
    expect(await screen.findByText("saída 1")).toBeInTheDocument();
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveValue("false");
    await user.keyboard("{ArrowUp}");
    expect(input).toHaveValue("cat leia.txt");
  });

  it("reattaches to a shell that is already open instead of starting another", async () => {
    const client = fakeClient();
    client.listTerminals.mockResolvedValue([{ ...session, cwd: "C:/p/docs" }]);
    render(<ProjectTerminal client={client} project={project} />);
    expect(await screen.findByText("C:/p/docs")).toBeInTheDocument();
    expect(client.openTerminal).not.toHaveBeenCalled();
  });
});
