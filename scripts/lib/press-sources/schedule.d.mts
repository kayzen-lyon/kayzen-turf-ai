/** Types de schedule.mjs, pour scripts/live-refresh.ts (allowJs désactivé). */
export const PRESS_PASS_INTERVAL_MS: number;
export const PRESS_PASS_MARGIN_MS: number;
export const PRESS_FIRST_HOUR: number;
export const PRESS_TOMORROW_HOUR: number;
export function parisHour(now?: number): number;
export function pressPassPlan(args: { now: number; lastPassAt: number | null; deadline: number }): { run: boolean; tomorrow: boolean };
export function selectionKey(raceId: string, source: string): string;
export function racesMissingSource<R extends { id: string }>(races: R[], existing: Set<string>, source: string): R[];
