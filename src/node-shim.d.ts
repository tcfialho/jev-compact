declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  pid: number;
  execPath: string;
  platform: string;
  version: string;
  cwd(): string;
  exit(code?: number): never;
  exitCode?: number;
  stdin: any;
  stdout: any;
  stderr: any;
};
declare const Buffer: any;
declare module 'node:fs/promises' {
  export const readFile: any; export const writeFile: any; export const appendFile: any; export const open: any;
  export const mkdir: any; export const rename: any; export const copyFile: any; export const rm: any; export const readdir: any; export const stat: any;
}
declare module 'node:fs' { export const existsSync: any; export const readFileSync: any; export const writeFileSync: any; }
declare module 'node:path' { export const join: any; export const dirname: any; export const resolve: any; export const basename: any; }
declare module 'node:os' { export const homedir: any; export const tmpdir: any; }
declare module 'node:http' { export const createServer: any; }
declare module 'node:url' { export const fileURLToPath: any; }
