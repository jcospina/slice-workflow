export type SnakeRow = Record<string, unknown>;

export function assertFound<T>(value: T | undefined, entity: string, id: string): T {
	if (value === undefined) {
		throw new Error(`${entity} not found: ${id}`);
	}
	return value;
}
