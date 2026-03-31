import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";
import {
	type FileReferenceSuppression,
	type FileReferenceViewState,
	findActiveFileReference,
	formatFileReference,
	insertFileReference,
	isFileReferenceSuppressed,
	resolveFileReferenceViewState,
} from "../file-references";

const CLEAR_TIMEOUT_MS = 3000;

// Raw escape sequences for Shift+Enter that Ink doesn't parse:
// xterm modifyOtherKeys: \x1b[27;2;13~  (Ink consumes \x1b, leaves [27;2;13~)
// Kitty CSI u:           \x1b[13;2u     (Ink consumes \x1b, leaves [13;2u)
const SHIFT_ENTER_RAW = /\[27;2;13~|\[13;2u/;
type InputKey = Parameters<Parameters<typeof useInput>[0]>[1];

interface TextAreaProps {
	placeholder?: string;
	onSubmit: (value: string) => void;
	onExit: () => void;
	onPendingClearChange?: (pending: boolean) => void;
	fileReferenceFiles?: readonly string[];
	onFileReferenceStateChange?: (state: FileReferenceViewState | null) => void;
}

function lineAt(lines: string[], index: number): string {
	return lines[index] ?? "";
}

function handleNewline(
	lines: string[],
	cursorRow: number,
	cursorCol: number,
): { lines: string[]; row: number; col: number } {
	const before = lineAt(lines, cursorRow).slice(0, cursorCol);
	const after = lineAt(lines, cursorRow).slice(cursorCol);
	return {
		lines: [...lines.slice(0, cursorRow), before, after, ...lines.slice(cursorRow + 1)],
		row: cursorRow + 1,
		col: 0,
	};
}

function handleBackspace(
	lines: string[],
	cursorRow: number,
	cursorCol: number,
): { lines: string[]; row: number; col: number } {
	if (cursorCol > 0) {
		const line = lineAt(lines, cursorRow);
		const updated = [...lines];
		updated[cursorRow] = line.slice(0, cursorCol - 1) + line.slice(cursorCol);
		return { lines: updated, row: cursorRow, col: cursorCol - 1 };
	}

	if (cursorRow > 0) {
		const prevLine = lineAt(lines, cursorRow - 1);
		const currentLine = lineAt(lines, cursorRow);
		const merged = prevLine + currentLine;
		return {
			lines: [...lines.slice(0, cursorRow - 1), merged, ...lines.slice(cursorRow + 1)],
			row: cursorRow - 1,
			col: prevLine.length,
		};
	}

	return { lines, row: cursorRow, col: cursorCol };
}

function handleArrowUp(lines: string[], row: number, col: number): { row: number; col: number } {
	if (row > 0) {
		return { row: row - 1, col: Math.min(col, lineAt(lines, row - 1).length) };
	}

	return { row, col };
}

function handleArrowDown(lines: string[], row: number, col: number): { row: number; col: number } {
	if (row < lines.length - 1) {
		return { row: row + 1, col: Math.min(col, lineAt(lines, row + 1).length) };
	}

	return { row, col };
}

function handleArrowLeft(lines: string[], row: number, col: number): { row: number; col: number } {
	if (col > 0) {
		return { row, col: col - 1 };
	}

	if (row > 0) {
		return { row: row - 1, col: lineAt(lines, row - 1).length };
	}

	return { row, col };
}

function handleArrowRight(lines: string[], row: number, col: number): { row: number; col: number } {
	if (col < lineAt(lines, row).length) {
		return { row, col: col + 1 };
	}

	if (row < lines.length - 1) {
		return { row: row + 1, col: 0 };
	}

	return { row, col };
}

function handleCharInput(
	input: string,
	lines: string[],
	cursorRow: number,
	cursorCol: number,
): { lines: string[]; col: number } {
	const updated = [...lines];
	const line = lineAt(lines, cursorRow);
	updated[cursorRow] = line.slice(0, cursorCol) + input + line.slice(cursorCol);
	return { lines: updated, col: cursorCol + input.length };
}

function clampHighlightedIndex(index: number, matches: readonly string[]): number {
	if (matches.length === 0) {
		return 0;
	}
	return Math.max(0, Math.min(index, matches.length - 1));
}

function moveHighlightedIndex(
	current: number,
	matches: readonly string[],
	direction: "up" | "down",
): number {
	const maxIndex = matches.length - 1;
	if (maxIndex < 0) {
		return 0;
	}
	if (direction === "up") {
		return current <= 0 ? 0 : current - 1;
	}
	return current >= maxIndex ? maxIndex : current + 1;
}

function navigateCursor(
	lines: string[],
	row: number,
	col: number,
	key: InputKey,
): { row: number; col: number } | null {
	if (key.home) {
		return { row, col: 0 };
	}
	if (key.end) {
		return { row, col: lineAt(lines, row).length };
	}
	if (key.upArrow) {
		return handleArrowUp(lines, row, col);
	}
	if (key.downArrow) {
		return handleArrowDown(lines, row, col);
	}
	if (key.leftArrow) {
		return handleArrowLeft(lines, row, col);
	}
	if (key.rightArrow) {
		return handleArrowRight(lines, row, col);
	}
	return null;
}

export function TextArea({
	placeholder = "",
	onSubmit,
	onExit,
	onPendingClearChange,
	fileReferenceFiles = [],
	onFileReferenceStateChange,
}: TextAreaProps) {
	const [lines, setLines] = useState<string[]>([""]);
	const [cursorRow, setCursorRow] = useState(0);
	const [cursorCol, setCursorCol] = useState(0);
	const [pendingClear, setPendingClear] = useState(false);
	const [highlightedIndex, setHighlightedIndex] = useState(0);
	const [suppressedReference, setSuppressedReference] = useState<FileReferenceSuppression | null>(
		null,
	);
	const pendingClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastReportedFileReferenceStateKey = useRef<string | null>(null);
	const activeLine = lineAt(lines, cursorRow);
	const activeReference = findActiveFileReference(activeLine, cursorCol);
	const isReferenceSuppressed = isFileReferenceSuppressed(
		activeReference,
		cursorRow,
		suppressedReference,
	);
	const fileReferenceState = isReferenceSuppressed
		? null
		: resolveFileReferenceViewState(fileReferenceFiles, activeLine, cursorCol, highlightedIndex);
	const isEmpty = lines.length === 1 && lines[0] === "";
	const fileReferenceStateKey = fileReferenceState
		? `${fileReferenceState.query}\u0000${fileReferenceState.highlightedIndex}\u0000${fileReferenceState.matches.join("\u0000")}`
		: "null";

	useEffect(() => {
		return () => {
			if (pendingClearTimer.current) {
				clearTimeout(pendingClearTimer.current);
			}
		};
	}, []);

	useEffect(() => {
		if (lastReportedFileReferenceStateKey.current === fileReferenceStateKey) {
			return;
		}
		lastReportedFileReferenceStateKey.current = fileReferenceStateKey;
		onFileReferenceStateChange?.(fileReferenceState);
	}, [fileReferenceState, fileReferenceStateKey, onFileReferenceStateChange]);

	useEffect(() => {
		if (!suppressedReference) {
			return;
		}

		if (!activeReference) {
			setSuppressedReference(null);
			return;
		}

		const stillSuppressed =
			suppressedReference.row === cursorRow &&
			suppressedReference.tokenStart === activeReference.tokenStart &&
			activeReference.query.startsWith(suppressedReference.query);

		if (!stillSuppressed) {
			setSuppressedReference(null);
		}
	}, [activeReference, cursorRow, suppressedReference]);

	useEffect(() => {
		if (!fileReferenceState) {
			return;
		}

		setHighlightedIndex((current) => {
			const next = clampHighlightedIndex(current, fileReferenceState.matches);
			return current === next ? current : next;
		});
	}, [fileReferenceState]);

	const updatePendingClear = (value: boolean) => {
		setPendingClear(value);
		onPendingClearChange?.(value);
	};

	const cancelPendingClear = () => {
		if (pendingClearTimer.current) {
			clearTimeout(pendingClearTimer.current);
			pendingClearTimer.current = null;
		}
		if (pendingClear) {
			updatePendingClear(false);
		}
	};

	const clearText = () => {
		setLines([""]);
		setCursorRow(0);
		setCursorCol(0);
		setHighlightedIndex(0);
		setSuppressedReference(null);
		cancelPendingClear();
	};

	const applyEdit = (result: { lines: string[]; row: number; col: number }) => {
		setLines(result.lines);
		setCursorRow(result.row);
		setCursorCol(result.col);
	};

	const applyMove = (pos: { row: number; col: number }) => {
		setCursorRow(pos.row);
		setCursorCol(pos.col);
	};

	const dismissFileReference = () => {
		if (!activeReference) {
			return;
		}

		cancelPendingClear();
		setSuppressedReference({
			row: cursorRow,
			tokenStart: activeReference.tokenStart,
			query: activeReference.query,
		});
	};

	const handleEscape = () => {
		if (isEmpty) {
			return;
		}
		if (pendingClear) {
			clearText();
		} else {
			updatePendingClear(true);
			pendingClearTimer.current = setTimeout(() => {
				updatePendingClear(false);
				pendingClearTimer.current = null;
			}, CLEAR_TIMEOUT_MS);
		}
	};

	const handleCtrlC = () => {
		if (isEmpty) {
			onExit();
		} else {
			clearText();
		}
	};

	const handleKeyMeta = (input: string, key: InputKey) => {
		if (key.escape) {
			if (fileReferenceState) {
				dismissFileReference();
				return true;
			}
			handleEscape();
			return true;
		}
		if (key.ctrl && input === "c") {
			handleCtrlC();
			return true;
		}
		return false;
	};

	const isShiftEnter = (input: string, key: InputKey) => {
		return (key.return && key.shift) || SHIFT_ENTER_RAW.test(input);
	};

	const selectHighlightedFileReference = () => {
		if (!(fileReferenceState && activeReference) || fileReferenceState.matches.length === 0) {
			return true;
		}

		const selectedPath =
			fileReferenceState.matches[highlightedIndex] ?? fileReferenceState.matches[0];
		const selected = insertFileReference(activeLine, cursorCol, selectedPath);
		const selectedReferenceBody = formatFileReference(selectedPath).slice(1);
		const nextLines = [...lines];
		nextLines[cursorRow] = selected.line;
		setLines(nextLines);
		setCursorCol(selected.cursorCol);
		setHighlightedIndex(0);
		setSuppressedReference({
			row: cursorRow,
			tokenStart: activeReference.tokenStart,
			query: selectedReferenceBody,
		});
		return true;
	};

	const handleReturnKey = () => {
		if (fileReferenceState) {
			return selectHighlightedFileReference();
		}

		const text = lines.join("\n").trim();
		if (text.length > 0) {
			onSubmit(text);
		}
		return true;
	};

	const handleKeyEdit = (input: string, key: InputKey) => {
		if (isShiftEnter(input, key)) {
			applyEdit(handleNewline(lines, cursorRow, cursorCol));
			return true;
		}

		if (key.return) {
			return handleReturnKey();
		}

		if (key.backspace || key.delete) {
			applyEdit(handleBackspace(lines, cursorRow, cursorCol));
			return true;
		}

		if (input && !key.tab && !key.ctrl) {
			const result = handleCharInput(input, lines, cursorRow, cursorCol);
			setLines(result.lines);
			setCursorCol(result.col);
			return true;
		}

		return false;
	};

	const handleKeyNav = (key: InputKey) => {
		if (fileReferenceState && (key.upArrow || key.downArrow)) {
			const direction = key.upArrow ? "up" : "down";
			setHighlightedIndex((current) =>
				moveHighlightedIndex(current, fileReferenceState.matches, direction),
			);
			return;
		}

		const nextCursor = navigateCursor(lines, cursorRow, cursorCol, key);
		if (nextCursor) {
			applyMove(nextCursor);
		}
	};

	useInput((input, key) => {
		if (!key.escape) {
			cancelPendingClear();
		}
		if (handleKeyMeta(input, key)) {
			return;
		}
		if (!handleKeyEdit(input, key)) {
			handleKeyNav(key);
		}
	});

	return (
		<Box flexDirection="column">
			{isEmpty ? (
				<Text>
					<Text inverse={true}> </Text>
					<Text dimColor={true}>{placeholder}</Text>
				</Text>
			) : (
				lines.map((line, i) => {
					const lineKey = `line-${String(i)}`;
					if (i === cursorRow) {
						const before = line.slice(0, cursorCol);
						const cursorChar = line[cursorCol] ?? " ";
						const after = line.slice(cursorCol + 1);
						return (
							<Text key={lineKey}>
								{before}
								<Text inverse={true}>{cursorChar}</Text>
								{after}
							</Text>
						);
					}
					return <Text key={lineKey}>{line || " "}</Text>;
				})
			)}
		</Box>
	);
}
