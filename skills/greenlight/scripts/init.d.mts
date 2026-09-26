export const STARTER: string;
export function repositoryRoot(cwd?: string): string;
export function saveInitialSetup(content: string, repoDir?: string): Promise<string>;
export interface InitOptions { repoDir?: string; setupFile?: string; prompt?: boolean }
export function parseInitOptions(args: string[]): InitOptions;
export function runGreenlightInit(options?: InitOptions): Promise<string>;
