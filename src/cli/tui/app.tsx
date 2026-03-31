import { Box, Text } from "ink";
import { useState } from "react";
import { banner } from "../ui/terminal";
import { Progress } from "./views/progress";
import { PromptEditor } from "./views/prompt-editor";

type View = { name: "prompt" } | { name: "progress"; prompt: string };

export function App() {
	const [view, setView] = useState<View>({ name: "prompt" });

	const handleSubmit = (prompt: string) => {
		setView({ name: "progress", prompt });
	};

	return (
		<Box flexDirection="column" gap={1}>
			<Text>{banner()}</Text>

			{view.name === "prompt" && <PromptEditor onSubmit={handleSubmit} />}
			{view.name === "progress" && <Progress prompt={view.prompt} />}
		</Box>
	);
}
