import { Box, Text, useInput } from "ink";
import { useEffect, useRef, useState } from "react";

const CLEAR_TIMEOUT_MS = 3000;

interface TextAreaProps {
	placeholder?: string;
	onSubmit: (value: string) => void;
	onExit: () => void;
	onPendingClearChange?: (pending: boolean) => void;
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

export function TextArea({
	placeholder = "",
	onSubmit,
	onExit,
	onPendingClearChange,
}: TextAreaProps) {
	const [lines, setLines] = useState<string[]>([""]);
	const [cursorRow, setCursorRow] = useState(0);
	const [cursorCol, setCursorCol] = useState(0);
	const [pendingClear, setPendingClear] = useState(false);
	const pendingClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const isEmpty = lines.length === 1 && lines[0] === "";

	useEffect(() => {
		return () => {
			if (pendingClearTimer.current) {
				clearTimeout(pendingClearTimer.current);
			}
		};
	}, []);

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

	const handleKeyMeta = (input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) => {
		if (key.escape) {
			handleEscape();
			return true;
		}
		if (key.ctrl && input === "c") {
			handleCtrlC();
			return true;
		}
		return false;
	};

	const handleKeyEdit = (input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]) => {
		if (key.return && !key.shift) {
			const text = lines.join("\n").trim();
			if (text.length > 0) {
				onSubmit(text);
			}
			return true;
		}
		if (key.return && key.shift) {
			applyEdit(handleNewline(lines, cursorRow, cursorCol));
			return true;
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

	const handleKeyNav = (key: Parameters<Parameters<typeof useInput>[0]>[1]) => {
		if (key.home) {
			setCursorCol(0);
		} else if (key.end) {
			setCursorCol(lineAt(lines, cursorRow).length);
		} else if (key.upArrow) {
			applyMove(handleArrowUp(lines, cursorRow, cursorCol));
		} else if (key.downArrow) {
			applyMove(handleArrowDown(lines, cursorRow, cursorCol));
		} else if (key.leftArrow) {
			applyMove(handleArrowLeft(lines, cursorRow, cursorCol));
		} else if (key.rightArrow) {
			applyMove(handleArrowRight(lines, cursorRow, cursorCol));
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
