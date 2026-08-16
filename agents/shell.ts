import { type ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type AgentsOverlayTheme = {
	fg: (color: ThemeColor, text: string) => string;
};

export type AgentsOverlayBody = string[] | ((contentWidth: number, bodyRows: number) => string[]);

export type AgentsOverlayRenderOptions = {
	width: number;
	terminalRows: number;
	theme: AgentsOverlayTheme;
	header: string;
	footer: string;
	body: AgentsOverlayBody;
};

export function agentsOverlayBodyRows(terminalRows: number): number {
	return Math.max(3, Math.floor(terminalRows * 0.8) - 6);
}

export function renderAgentsOverlay(options: AgentsOverlayRenderOptions): string[] {
	const { width, terminalRows, theme, header, footer, body } = options;
	const contentWidth = Math.max(0, width - 4);
	const bodyRows = agentsOverlayBodyRows(terminalRows);
	const horizontalBorder = "─".repeat(Math.max(0, width - 2));
	const box = (line: string) => {
		const clipped = truncateToWidth(line, contentWidth);
		return theme.fg("border", "│ ") + clipped + " ".repeat(Math.max(0, contentWidth - visibleWidth(clipped))) + theme.fg("border", " │");
	};
	const bodyLines = typeof body === "function" ? body(contentWidth, bodyRows) : body;
	const lines = [theme.fg("border", `╭${horizontalBorder}╮`), box(header), theme.fg("border", `├${horizontalBorder}┤`)];
	for (let index = 0; index < bodyRows; index++) lines.push(box(bodyLines[index] ?? ""));
	lines.push(theme.fg("border", `├${horizontalBorder}┤`), box(footer), theme.fg("border", `╰${horizontalBorder}╯`));
	return lines;
}
