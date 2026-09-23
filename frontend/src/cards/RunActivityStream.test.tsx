import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useLocale } from "../i18n";
import type { RunActivityState } from "../state/runActivity";
import { RunActivityStream } from "./RunActivityStream";

vi.mock("./MarkdownMessage", () => ({ MarkdownMessage: ({ content }: { content: string }) => <p>{content}</p> }));

const activity: RunActivityState = { seen: [], truncated: false, items: [
  { id: "1", type: "agent_progress", text: "Read the configuration" },
  { id: "2", type: "tool_started", name: "read_file", call_id: "c", arguments: { path: "config.json", limit: 100 } },
  { id: "3", type: "agent_progress", text: "Compare its values" },
] };

describe("Run activity surface", () => {
  it("puts Stop below the ordered stream without a large running heading", () => {
    useLocale.setState({ locale: "en" });
    const stop = vi.fn();
    const { container } = render(<RunActivityStream activity={activity} active onStop={stop} />);
    expect(container.querySelector(".conversation-run-heading")).toBeNull();
    expect(container.querySelector(".run-activity-items")?.textContent).toMatch(/Read the configuration.*read_file.*Compare its values/);
    const button = screen.getByRole("button", { name: "Stop" });
    expect(button.closest(".run-activity-footer")).toBeTruthy();
    expect(container.querySelector(".run-activity-items")!.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(button);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("mounts tool details only when opened and keeps them open on completion", () => {
    useLocale.setState({ locale: "en" });
    const view = render(<RunActivityStream activity={activity} active />);
    const tool = view.container.querySelector(".run-tool") as HTMLDetailsElement;
    expect(tool.querySelector("pre")).toBeNull();
    act(() => { tool.open = true; fireEvent(tool, new Event("toggle", { bubbles: true })); });
    expect(within(tool).getByText(/"limit": 100/)).toBeTruthy();
    view.rerender(<RunActivityStream active activity={{ ...activity, items: activity.items.map(item => item.id === "2"
      ? { ...item, type: "tool_completed", response: { content: "file contents" } } : item) }} />);
    expect(tool.open).toBe(true);
    expect(within(tool).getByText(/file contents/)).toBeTruthy();
  });
});
