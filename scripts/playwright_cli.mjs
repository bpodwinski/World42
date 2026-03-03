import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);

if (args.length === 0) {
    console.error('Usage: npm run pw -- <playwright-cli command> [args]');
    console.error('Example: npm run pw -- open http://localhost:19000 --headed');
    process.exit(1);
}

const outputDir = join(process.cwd(), 'output', 'playwright');
mkdirSync(outputDir, { recursive: true });

const npxArgs = ['--yes', '--package', '@playwright/cli', 'playwright-cli'];
const session = process.env.PW_SESSION?.trim();
if (session) npxArgs.push(`-s=${session}`);
npxArgs.push(...args);

const child = spawn('npx', npxArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
        ...process.env,
        PW_OUTPUT_DIR: outputDir,
    },
});

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 1);
});

