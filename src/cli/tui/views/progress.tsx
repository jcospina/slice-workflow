import { Box, Text } from "ink";
import Spinner from "ink-spinner";

interface ProgressProps {
	prompt: string;
}

export function Progress({ prompt }: ProgressProps) {
	return (
		<Box flexDirection="column" gap={1}>
			<Box>
				<Text color="green">
					<Spinner type="dots" />
				</Text>
				<Text> Processing workflow…</Text>
			</Box>

			<Box flexDirection="column" paddingLeft={2}>
				<Text dimColor={true}>Task:</Text>
				<Text>{prompt.length > 80 ? `${prompt.slice(0, 77)}…` : prompt}</Text>
			</Box>

			<Text dimColor={true}>This is a placeholder — workflow execution coming soon.</Text>
		</Box>
	);
}
