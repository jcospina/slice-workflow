import { Box, Text, useApp } from "ink";
import { useState } from "react";
import { TextArea } from "../components/text-area";

interface PromptEditorProps {
	onSubmit: (prompt: string) => void;
}

export function PromptEditor({ onSubmit }: PromptEditorProps) {
	const { exit } = useApp();
	const [pendingClear, setPendingClear] = useState(false);

	return (
		<Box flexDirection="column" gap={1}>
			<Box flexDirection="column">
				<Text bold={true} color="cyan">
					What would you like to build?
				</Text>
				<Text dimColor={true}>Enter your task description.</Text>
			</Box>

			<Box borderStyle="round" borderColor="gray" paddingX={1} minHeight={6} flexDirection="column">
				<TextArea
					placeholder="Describe the feature, bug fix, or task you want to work on..."
					onSubmit={onSubmit}
					onExit={exit}
					onPendingClearChange={setPendingClear}
				/>
			</Box>

			{pendingClear ? (
				<Text color="yellow">Press Esc again to clear</Text>
			) : (
				<Text dimColor={true}>Shift+Enter new line · Enter submit · Esc clear · Ctrl+C exit</Text>
			)}
		</Box>
	);
}
