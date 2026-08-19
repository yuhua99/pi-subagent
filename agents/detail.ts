import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  getMarkdownTheme,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  Input,
  Markdown,
  type OverlayOptions,
  type TUI,
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { agentsOverlayBodyRows, renderAgentsOverlay } from "./shell.ts";
import { createDetailToolRenderers, isDetailQuietTool } from "./detail_tools.ts";
import { formatElapsed, formatUsage, type ThemeFg } from "../tool/render.ts";
import { getRun, listCompletedRuns } from "../execution/registry.ts";
import { isResultError, type SingleResult } from "../types.ts";

const REFRESH_MS = 1000;
const PLAIN_THEME: { fg: ThemeFg } = { fg: (_color, text) => text };

export interface DetailEntry {
  id: string;
  agent: string;
  task: string;
  taskSummary?: string;
  startedAt: number;
  finishedAt?: number;
  result: SingleResult;
  onStatus?: (fn: () => void) => () => void;
  onStream?: (fn: () => void) => () => void;
}

function userMessageText(message: UserMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((content) => (content.type === "text" ? content.text : "")).join("");
}

function paneView(
  lines: string[],
  offset: number,
  height: number,
  theme: { fg: ThemeFg },
): string[] {
  const total = lines.length;
  if (total === 0 || height <= 0) return [];
  const view = lines.slice(offset, offset + height).slice();
  const hiddenAbove = offset;
  const hiddenBelow = Math.max(0, total - (offset + height));
  if (hiddenAbove > 0 && view.length > 0) {
    view[0] = theme.fg("dim", `↑ ${hiddenAbove + 1} more`);
  }
  if (hiddenBelow > 0 && view.length > 0) {
    view[view.length - 1] = theme.fg("dim", `↓ ${hiddenBelow + 1} more`);
  }
  return view;
}

type LineCache = {
  lines?: string[];
  linesWidth?: number;
  nonCacheable?: boolean;
};

type AssistantCacheEntry = LineCache & {
  component: AssistantMessageComponent;
  message: AssistantMessage;
};

type ToolCacheEntry = LineCache & {
  component: ToolExecutionComponent;
  args: Record<string, unknown>;
  result?: ToolResultMessage;
};

type TranscriptComponent = {
  component: { render(width: number): string[] };
  cache?: LineCache;
};

export class NativeTranscriptRenderer {
  assistants = new Map<string, AssistantCacheEntry>();
  tools = new Map<string, ToolCacheEntry>();
  userLines = new Map<string, LineCache>();
  steerLines = new Map<string, LineCache>();
  detailTools: ReturnType<typeof createDetailToolRenderers>;
  transcript: Pick<SingleResult, "messages" | "partialMessage"> | undefined;
  tui: TUI;
  cwd: string;

  constructor(tui: TUI, cwd: string) {
    this.tui = tui;
    this.cwd = cwd;
    this.detailTools = createDetailToolRenderers(cwd);
  }

  clear() {
    this.assistants.clear();
    this.tools.clear();
    this.userLines.clear();
    this.steerLines.clear();
    this.detailTools.clear();
  }

  render(
    result: Pick<SingleResult, "messages" | "partialMessage">,
    width: number,
    steers: readonly { text: string; at: number }[] = [],
    theme: { fg: ThemeFg } = PLAIN_THEME,
  ): string[] {
    if (this.transcript && this.transcript !== result) this.clear();
    this.transcript = result;
    const components: TranscriptComponent[] = [];
    const toolCalls = new Map<string, ToolCacheEntry>();
    const activeAssistants = new Set<string>();
    const activeTools = new Set<string>();
    const quietTools: ToolCacheEntry[] = [];
    const toolCallIds: string[] = [];
    const messages = result.partialMessage
      ? [...result.messages, result.partialMessage]
      : result.messages;
    const resultIds = new Set(
      messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])),
    );
    const deliveredSteers = new Map<string, number>();
    let assistantIndex = 0;
    let userIndex = 0;
    let quietChanged = false;

    for (const message of messages) {
      if (message.role === "assistant") {
        const assistantKey = `${assistantIndex++}:${message.timestamp}`;
        let assistant = this.assistants.get(assistantKey);
        if (!assistant) {
          assistant = { component: new AssistantMessageComponent(message), message };
          this.assistants.set(assistantKey, assistant);
        } else if (assistant.message !== message) {
          assistant.component.updateContent(message);
          assistant.message = message;
          assistant.lines = undefined;
        }
        activeAssistants.add(assistantKey);
        components.push({ component: assistant.component, cache: assistant });
        for (const content of message.content) {
          if (content.type !== "toolCall") continue;
          const toolKey = `${assistantKey}:${content.id}`;
          const quiet = isDetailQuietTool(content.name);
          let tool = this.tools.get(toolKey);
          if (tool?.result && !resultIds.has(content.id)) {
            this.detailTools.reset(content.id);
            this.tools.delete(toolKey);
            tool = undefined;
            quietChanged ||= quiet;
          }
          if (!tool) {
            tool = {
              component: new ToolExecutionComponent(
                content.name,
                content.id,
                content.arguments,
                quiet ? { showImages: false } : undefined,
                this.detailTools.definition(content.name),
                this.tui,
                this.cwd,
              ),
              args: content.arguments,
            };
            this.tools.set(toolKey, tool);
            quietChanged ||= quiet;
          } else if (tool.args !== content.arguments) {
            tool.component.updateArgs(content.arguments);
            tool.args = content.arguments;
            tool.lines = undefined;
            quietChanged ||= quiet;
          }
          activeTools.add(toolKey);
          toolCalls.set(content.id, tool);
          toolCallIds.push(content.id);
          if (quiet) quietTools.push(tool);
          components.push({ component: tool.component, cache: tool });
        }
      } else if (message.role === "user") {
        const text = userMessageText(message);
        const key = `${userIndex++}:${text}`;
        const cache = this.userLines.get(key) ?? {};
        this.userLines.set(key, cache);
        deliveredSteers.set(text, (deliveredSteers.get(text) ?? 0) + 1);
        components.push({
          component: {
            render: (renderWidth) =>
              wrapTextWithAnsi(theme.fg("userMessageText", `» ${text}`), renderWidth),
          },
          cache,
        });
      } else if (message.role === "toolResult") {
        const tool = toolCalls.get(message.toolCallId);
        if (!tool) continue;
        if (tool.result !== message) {
          tool.component.updateResult(message);
          tool.lines = undefined;
          tool.nonCacheable ||=
            !isDetailQuietTool(message.toolName) &&
            message.content.some((content) => content.type === "image");
          quietChanged ||= isDetailQuietTool(message.toolName);
        }
        tool.result = message;
      }
    }

    for (const steer of steers) {
      const delivered = deliveredSteers.get(steer.text) ?? 0;
      if (delivered > 0) {
        deliveredSteers.set(steer.text, delivered - 1);
        continue;
      }
      const key = JSON.stringify([steer.at, steer.text]);
      const cache = this.steerLines.get(key) ?? {};
      this.steerLines.set(key, cache);
      components.push({
        component: {
          render: (renderWidth) =>
            wrapTextWithAnsi(theme.fg("dim", `» steer: ${steer.text}`), renderWidth),
        },
        cache,
      });
    }

    this.detailTools.sync(toolCallIds);
    if (quietChanged) {
      for (const tool of quietTools) {
        tool.component.invalidate();
        tool.lines = undefined;
      }
    }

    for (const key of this.assistants.keys()) {
      if (!activeAssistants.has(key)) this.assistants.delete(key);
    }
    for (const key of this.tools.keys()) {
      if (!activeTools.has(key)) this.tools.delete(key);
    }
    return components.flatMap(({ component, cache }) => {
      if (cache?.lines && cache.linesWidth === width && !cache.nonCacheable) return cache.lines;
      const lines = component.render(width).flatMap((line) => wrapTextWithAnsi(line, width));
      if (cache && !cache.nonCacheable) {
        cache.lines = lines;
        cache.linesWidth = width;
      }
      return lines;
    });
  }

  dispose() {
    this.clear();
    this.transcript = undefined;
  }
}

export function showAgentsDetail(
  ctx: ExtensionCommandContext,
  entry: DetailEntry,
  overlayOptions: OverlayOptions,
): Promise<null> {
  return ctx.ui.custom<null>(
    (tui, theme, _kb, done) => {
      let timer: NodeJS.Timeout | undefined;
      const transcriptRenderer = new NativeTranscriptRenderer(tui, ctx.cwd);
      const taskMarkdown = new Markdown(entry.task, 0, 0, getMarkdownTheme(), {
        color: (text) => theme.fg("text", text),
      });
      const unsubscribeStatus = entry.onStatus?.(() => tui.requestRender());
      const unsubscribeStream = entry.onStream?.(() => tui.requestRender());

      let activePane: "task" | "transcript" | "input" = "transcript";
      const input = new Input();
      let focused = false;
      const updateInputFocus = () => {
        input.focused = focused && activePane === "input";
      };
      input.onSubmit = (value) => {
        const steer = value.trim();
        if (!steer) return;
        getRun(entry.id)?.steer(steer);
        input.setValue("");
        tui.requestRender();
      };
      input.onEscape = () => {
        activePane = "transcript";
        tui.requestRender();
      };
      let steers: readonly { text: string; at: number }[] = [];
      let taskScroll = 0;
      let transcriptScroll: number | null = null;
      let lastTaskMax = 0;
      let lastTranscriptMax = 0;

      const finish = () => {
        unsubscribeStatus?.();
        unsubscribeStream?.();
        if (timer) clearInterval(timer);
        transcriptRenderer.dispose();
        done(null);
      };

      if (entry.onStatus || entry.onStream) {
        timer = setInterval(() => tui.requestRender(), REFRESH_MS);
        timer.unref?.();
      }

      return {
        get focused() {
          return focused;
        },
        set focused(value: boolean) {
          focused = value;
          updateInputFocus();
        },
        render: (width: number) => {
          const live = getRun(entry.id);
          const completed = live
            ? undefined
            : listCompletedRuns().find((run) => run.id === entry.id);
          const completedSteers = completed?.steers;
          const result = live?.result ?? completed?.result ?? entry.result;
          const finishedAt = completed?.finishedAt ?? entry.finishedAt;
          const taskSummary = live?.taskSummary ?? completed?.taskSummary ?? entry.taskSummary;
          steers = live?.steers ?? completedSteers ?? steers;
          if (result.exitCode !== -1 && timer) {
            clearInterval(timer);
            timer = undefined;
          }
          const contentWidth = width - 4;
          const running = Boolean(live && result.exitCode === -1);
          if (!running && activePane === "input") activePane = "transcript";
          updateInputFocus();
          const icon = running
            ? theme.fg("warning", "○")
            : isResultError(result)
              ? theme.fg("error", "✗")
              : theme.fg("success", "✓");
          const startedAt = live?.startedAt ?? entry.startedAt;
          const status = running
            ? formatElapsed(Date.now() - startedAt)
            : finishedAt !== undefined
              ? formatElapsed(finishedAt - startedAt)
              : "finished";

          const usage = formatUsage(result.usage, result.model);
          const escapeText = running
            ? "tab panes/input · ↑↓/c-u/d scroll · esc back"
            : "tab panes · ↑↓/c-u/d scroll · esc back";
          const footerGap = Math.max(
            1,
            contentWidth - visibleWidth(escapeText) - visibleWidth(usage),
          );
          const footer = usage
            ? theme.fg("dim", escapeText) + " ".repeat(footerGap) + theme.fg("dim", usage)
            : theme.fg("dim", escapeText);
          const paneBadge =
            " " + theme.fg("dim", "[") + theme.fg("accent", activePane) + theme.fg("dim", "]");

          return renderAgentsOverlay({
            width,
            terminalRows: tui.terminal.rows,
            theme,
            header: `${icon} ${theme.fg("accent", theme.bold(`[${entry.id}] ${entry.agent}`))}${taskSummary ? theme.fg("dim", ` — ${taskSummary}`) : ""} ${theme.fg("muted", `— ${status}`)}${paneBadge}`,
            body: (bodyWidth, bodyRows) => {
              const paneRows = running ? bodyRows - 1 : bodyRows;
              const taskWidth = Math.max(5, Math.floor(bodyWidth * 0.3));
              const transcriptWidth = Math.max(1, bodyWidth - taskWidth - 3);
              const taskWrapped = taskMarkdown.render(taskWidth);
              lastTaskMax = Math.max(0, taskWrapped.length - paneRows);
              taskScroll = Math.min(Math.max(0, taskScroll), lastTaskMax);
              const taskColumn = paneView(taskWrapped, taskScroll, paneRows, theme);
              const transcript: string[] = [];
              transcript.push(...transcriptRenderer.render(result, transcriptWidth, steers, theme));
              lastTranscriptMax = Math.max(0, transcript.length - paneRows);
              if (transcriptScroll !== null) {
                transcriptScroll = Math.min(Math.max(0, transcriptScroll), lastTranscriptMax);
              }
              const transcriptOffset = transcriptScroll ?? lastTranscriptMax;
              let transcriptColumn = paneView(transcript, transcriptOffset, paneRows, theme);
              if (transcriptColumn.length === 0)
                transcriptColumn = [theme.fg("muted", "(no output yet)")];
              const pad = (line: string, columnWidth: number) =>
                line + " ".repeat(Math.max(0, columnWidth - visibleWidth(line)));
              const separator = ` ${theme.fg("border", "│")} `;
              const panes = Array.from(
                { length: paneRows },
                (_, index) =>
                  pad(taskColumn[index] ?? "", taskWidth) +
                  separator +
                  (transcriptColumn[index] ?? ""),
              );
              if (!running) return panes;
              if (activePane !== "input")
                return [...panes, theme.fg("dim", `» steer: ${input.getValue()}`)];
              const prompt = theme.fg("accent", theme.bold("» steer: "));
              const inputLine =
                input.render(Math.max(1, bodyWidth - visibleWidth(prompt) + 2))[0] ?? "";
              return [...panes, prompt + inputLine.slice(2)];
            },
            footer,
          });
        },
        invalidate: () => {},
        handleInput: (data: string) => {
          if (matchesKey(data, "escape")) {
            if (activePane === "input") {
              activePane = "transcript";
              tui.requestRender();
              return;
            }
            finish();
            return;
          }
          if (data === "\t") {
            const panes: Array<typeof activePane> = getRun(entry.id)
              ? ["task", "transcript", "input"]
              : ["task", "transcript"];
            activePane = panes[(panes.indexOf(activePane) + 1) % panes.length]!;
            tui.requestRender();
            return;
          }
          if ((matchesKey(data, "left") || matchesKey(data, "right")) && activePane !== "input") {
            activePane = activePane === "task" ? "transcript" : "task";
            tui.requestRender();
            return;
          }
          if (activePane === "input") {
            input.handleInput(data);
            tui.requestRender();
            return;
          }
          const ctrlU = matchesKey(data, "ctrl+u");
          const ctrlD = matchesKey(data, "ctrl+d");
          if (matchesKey(data, "up") || data === "k" || ctrlU) {
            const step = ctrlU
              ? Math.max(1, Math.floor(agentsOverlayBodyRows(tui.terminal.rows) / 2))
              : 1;
            if (activePane === "task") {
              taskScroll = Math.max(0, taskScroll - step);
            } else {
              const effective = transcriptScroll ?? lastTranscriptMax;
              transcriptScroll = Math.max(0, effective - step);
            }
            tui.requestRender();
            return;
          }
          if (matchesKey(data, "down") || data === "j" || ctrlD) {
            const step = ctrlD
              ? Math.max(1, Math.floor(agentsOverlayBodyRows(tui.terminal.rows) / 2))
              : 1;
            if (activePane === "task") {
              taskScroll = Math.min(lastTaskMax, taskScroll + step);
            } else {
              const effective = transcriptScroll ?? lastTranscriptMax;
              const next = effective + step;
              transcriptScroll = next >= lastTranscriptMax ? null : next;
            }
            tui.requestRender();
            return;
          }
          if (data === "g") {
            if (activePane === "task") taskScroll = 0;
            else transcriptScroll = 0;
            tui.requestRender();
            return;
          }
          if (data === "G") {
            if (activePane === "task") taskScroll = lastTaskMax;
            else transcriptScroll = null;
            tui.requestRender();
          }
        },
      };
    },
    { overlay: true, overlayOptions },
  );
}
