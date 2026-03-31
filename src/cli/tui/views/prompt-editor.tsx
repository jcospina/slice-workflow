import { Box, Text, useApp } from "ink";
import { useState } from "react";
import { TextArea } from "../components/text-area";
import { type FileReferenceViewState, listWorkspaceFiles } from "../file-references";

interface PromptEditorProps {
	onSubmit: (prompt: string) => void;
}

function renderFileReferenceSuggestions(state: FileReferenceViewState | null) {
	if (!state) {
		return null;
	}

	return (
		<Box flexDirection="column" paddingLeft={1}>
			{state.matches.length === 0 ? (
				<Text dimColor={true}>No files match</Text>
			) : (
				state.matches.map((path, index) => {
					const selected = index === state.highlightedIndex;
					return (
						<Text
							key={path}
							backgroundColor={selected ? "cyan" : undefined}
							color={selected ? "black" : undefined}
						>
							{selected ? "> " : "  "}
							{path}
						</Text>
					);
				})
			)}
		</Box>
	);
}

export function PromptEditor({ onSubmit }: PromptEditorProps) {
	const { exit } = useApp();
	const [pendingClear, setPendingClear] = useState(false);
	const [fileReferenceState, setFileReferenceState] = useState<FileReferenceViewState | null>(null);
	const [workspaceFiles] = useState<string[]>(() => {
		try {
			return listWorkspaceFiles(process.cwd());
		} catch {
			return [];
		}
	});

	return (
		<Box flexDirection="column" gap={1}>
			<Box flexDirection="column">
				<Text bold={true} color="cyan">
					What would you like to build?
				</Text>
				<Text dimColor={true}>Enter your task description.</Text>
			</Box>

			<Box borderStyle="round" borderColor="gray" paddingX={1} minHeight={2} flexDirection="column">
				<TextArea
					placeholder="Describe the feature, bug fix, or task you want to work on..."
					onSubmit={onSubmit}
					onExit={exit}
					onPendingClearChange={setPendingClear}
					fileReferenceFiles={workspaceFiles}
					onFileReferenceStateChange={setFileReferenceState}
				/>
			</Box>

			{renderFileReferenceSuggestions(fileReferenceState)}

			{pendingClear ? (
				<Text color="yellow">Press Esc again to clear</Text>
			) : fileReferenceState ? (
				<Text dimColor={true}>Up/Down choose · Enter insert · Esc close</Text>
			) : (
				<Text dimColor={true}>Shift+Enter new line · Enter submit · Esc clear · Ctrl+C exit</Text>
			)}
		</Box>
	);
}
