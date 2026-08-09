import type { ToolRenderResultOptions } from "@gsd/pi-coding-agent";
import stripAnsi from "strip-ansi";
import { Text, type Component } from "@gsd/pi-tui";

/**
 * Local, dependency-free implementations of visibleWidth and
 * truncateToWidth. We deliberately do NOT import from @gsd/pi-tui/utils.js
 * because that subpath is not guaranteed to be installed alongside the
 * extension: gsd-pi bundles the runtime but does not exercise our
 * extendsions' node_modules, so a subpath import resolves to a path
 * that does not exist on disk. The result is a runtime crash:
 *   Cannot find module '.../pi-tui/dist/index.js/utils.js'
 * The visibleWidth / truncateToWidth APIs we use here are small enough
 * to inline without losing visibly correct behaviour for the cases
 * that matter (agent transcript summary, status lines).
 *
 * ponytail: drop these if @gsd/pi-tui ever ships a stable subpath export
 * or we switch to bundling the dependency into the tarball.
 */

/**
 * Approximate visible width in terminal columns. Honors East Asian
 * wide characters (CJK) via a small lookup table because Intl.Segmenter
 * is overkill for the 4 callers we have here.
 */
function visibleWidth(str: string): number {
	if (str.length === 0) return 0;
	let width = 0;
	for (const char of str) {
		const codePoint = char.codePointAt(0);
		if (codePoint === undefined) continue;
		// ANSI escape sequences are zero-width from the terminal's POV.
		if (codePoint === 0x1b) continue;
		// Combining marks, zero-width spaces, etc. don't add a column.
		if (
			(codePoint >= 0x0300 && codePoint <= 0x036f) ||
			(codePoint >= 0x200b && codePoint <= 0x200f) ||
			(codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
			codePoint === 0x00ad
		) {
			continue;
		}
		// CJK unified ideographs, hiragana, katakana, hangul, fullwidth
		// forms are double-width. This is the same generalisation
		// East Asian Width would give; we inline for performance.
		if (
			(codePoint >= 0x1100 && codePoint <= 0x115f) ||
			(codePoint >= 0x2e80 && codePoint <= 0x303e) ||
			(codePoint >= 0x3041 && codePoint <= 0x33ff) ||
			(codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
			(codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
			(codePoint >= 0xa000 && codePoint <= 0xa4cf) ||
			(codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
			(codePoint >= 0xf900 && codePoint <= 0xfaff) ||
			(codePoint >= 0xfe30 && codePoint <= 0xfe4f) ||
			(codePoint >= 0xff00 && codePoint <= 0xff60) ||
			(codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
			(codePoint >= 0x20000 && codePoint <= 0x2fffd) ||
			(codePoint >= 0x30000 && codePoint <= 0x3fffd)
		) {
			width += 2;
			continue;
		}
		width += 1;
	}
	return width;
}

/**
 * Approximate truncate-to-width. Counts columns via visibleWidth above
 * and slices by code points (not UTF-16 code units) so we don't cut a
 * surrogate pair in half. For the constrained "summary line" use case
 * this is good enough; exact grapheme-aware truncation is not needed.
 */
function truncateToWidth(
	text: string,
	maxWidth: number,
	ellipsis: string = "…",
): string {
	if (maxWidth <= 0) return ellipsis;
	if (visibleWidth(text) <= maxWidth) return text;
	const target = Math.max(0, maxWidth - visibleWidth(ellipsis));
	let acc = 0;
	let result = "";
	for (const char of text) {
		const codePoint = char.codePointAt(0);
		if (codePoint === undefined) continue;
		const charWidth = codePoint >= 0x1100 && codePoint <= 0x115f ? 2 : 1;
		if (acc + charWidth > target) break;
		result += char;
		acc += charWidth;
	}
	return result + ellipsis;
}

/**
 * Find the code-point index that approximately corresponds to `startCol`
 * columns into the string. Used by compactSummary to drop a head/tail
 * window where exact grapheme boundaries would be ideal but ASCII-safe
 * column arithmetic is sufficient for the summary line.
 */
function sliceByColumns(
	text: string,
	startCol: number,
	length: number,
): string {
	let acc = 0;
	let startIdx = -1;
	let endIdx = text.length;
	let result = "";
	for (let i = 0; i < text.length; ) {
		const codePoint = text.codePointAt(i);
		if (codePoint === undefined) {
			i++;
			continue;
		}
		const charWidth = codePoint >= 0x1100 && codePoint <= 0x115f ? 2 : 1;
		const charLen = codePoint > 0xffff ? 2 : 1;
		if (startIdx === -1 && acc >= startCol) {
			startIdx = i;
		}
		if (acc - startCol >= length) {
			endIdx = i;
			break;
		}
		if (startIdx !== -1) result += String.fromCodePoint(codePoint);
		acc += charWidth;
		i += charLen;
	}
	if (startIdx === -1) {
		// startCol was past the end of the string.
		return "";
	}
	// Use the trimmed result; we always pass code-unit pointers so the
	// result is a valid UTF-16 string.
	void endIdx;
	return result;
}

export type SharedStatus = "success" | "failure" | "empty";

export interface SharedOutputView {
	summary: string;
	expandedText: string;
	status: SharedStatus;
}

interface SharedOutputTheme {
	fg?: (color: any, text: string) => string;
	getBgAnsi?: (color: any) => string;
}

type ToolCardBackground = "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function textBlocks(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content.flatMap((item) => {
		const block = record(item);
		return block?.type === "text" && typeof block.text === "string"
			? [block.text]
			: [];
	});
}

function sanitizeDisplayText(text: string): string {
	return stripAnsi(text).replace(
		/[\p{Cc}\p{Cs}\uFFF9-\uFFFB]/gu,
		(character) => (character === "\n" || character === "\t" ? character : ""),
	);
}

function firstLine(text: string): string {
	return (
		text
			.split(/\r?\n/)
			.find((line) => line.trim())
			?.trim() ?? ""
	);
}

function reason(details: Record<string, unknown> | null): string {
	for (const value of [details?.error, details?.message, details?.reason]) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

export function normalizeSharedOutputView(input: unknown): SharedOutputView {
	const result = record(input);
	const details = record(result?.details);
	const expandedText = sanitizeDisplayText(
		textBlocks(result?.content).join("\n"),
	);
	const detailsReason = sanitizeDisplayText(reason(details));
	const failure =
		result?.isError === true ||
		details?.success === false ||
		details?.isError === true;
	const status: SharedStatus = failure
		? "failure"
		: expandedText.trim()
			? "success"
			: "empty";
	const summary = failure
		? detailsReason || firstLine(expandedText) || "Error"
		: firstLine(expandedText) || detailsReason || "No output";
	return { summary, expandedText, status };
}

function themed(
	theme: SharedOutputTheme | undefined,
	status: SharedStatus,
	partial: boolean,
	text: string,
): string {
	if (typeof theme?.fg !== "function") return text;
	const color = partial
		? "warning"
		: status === "failure"
			? "error"
			: status === "empty"
				? "muted"
				: "toolOutput";
	return theme.fg(color, text);
}

function restoreBackground(
	text: string,
	background: ToolCardBackground,
	theme: SharedOutputTheme | undefined,
): string {
	if (typeof theme?.getBgAnsi !== "function") return text;
	const backgroundAnsi = theme.getBgAnsi(background);
	return text.replace(/\x1b\[[0-?]*[ -/]*m/g, `$&${backgroundAnsi}`);
}

function compactSummary(
	summary: string,
	width: number,
	preserveTail: boolean,
): string {
	if (visibleWidth(summary) <= width) return summary;
	if (!preserveTail || width < 13) return truncateToWidth(summary, width, "…");

	const tailWidth = Math.max(6, Math.floor(width / 2));
	const headWidth = Math.max(3, width - tailWidth - 1);
	const fullWidth = visibleWidth(summary);
	return `${sliceByColumns(summary, 0, headWidth)}…${sliceByColumns(
		summary,
		Math.max(0, fullWidth - tailWidth),
		tailWidth,
	)}`;
}

function renderView(
	view: SharedOutputView,
	options: ToolRenderResultOptions,
	theme: SharedOutputTheme | undefined,
	background: ToolCardBackground,
): Component {
	if (options.expanded) {
		return new Text(view.expandedText || view.summary, 0, 0, (line) =>
			restoreBackground(line, background, theme),
		);
	}

	return {
		render(width: number): string[] {
			const availableWidth = Math.max(1, width);
			const partialPrefix =
				options.isPartial &&
				!/progress|partial|in progress|处理中/i.test(view.summary)
					? "In progress: "
					: "";
			const fullSummary = `${partialPrefix}${view.summary}`;
			const hasHiddenText = view.expandedText.trim() !== view.summary.trim();
			const hint = hasHiddenText ? " (to expand)" : "";
			const hintWidth = visibleWidth(hint);
			const visibleHint = hintWidth < availableWidth ? hint : "";
			const summaryWidth = Math.max(
				1,
				availableWidth - visibleWidth(visibleHint),
			);
			const summary = compactSummary(
				fullSummary,
				summaryWidth,
				view.status === "failure" || /warning/i.test(fullSummary),
			);
			const line = themed(
				theme,
				view.status,
				options.isPartial,
				`${summary}${visibleHint}`,
			);
			return [restoreBackground(line, background, theme)];
		},
		invalidate(): void {},
	};
}

export function createSharedToolResultRenderer(
	adapt: (result: unknown) => SharedOutputView = normalizeSharedOutputView,
) {
	return (
		result: unknown,
		options: ToolRenderResultOptions,
		theme: SharedOutputTheme,
		context?: { isError?: boolean },
	): Component => {
		const adapted = adapt(result);
		const displayView = {
			...adapted,
			summary: sanitizeDisplayText(adapted.summary),
			expandedText: sanitizeDisplayText(adapted.expandedText),
		};
		const view = context?.isError
			? { ...displayView, status: "failure" as const }
			: displayView;
		const background: ToolCardBackground = options.isPartial
			? "toolPendingBg"
			: context?.isError
				? "toolErrorBg"
				: "toolSuccessBg";
		return renderView(view, options, theme, background);
	};
}
