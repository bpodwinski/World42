import { spawn } from 'node:child_process';
import process from 'node:process';

const defaultPort = process.env.PORT && process.env.PORT !== '0'
    ? process.env.PORT
    : '19000';
const url = process.env.PW_URL || `http://localhost:${defaultPort}/`;
const headed = process.env.PW_HEADED === '0' ? [] : ['--headed'];

const child = spawn(
    process.execPath,
    ['./scripts/playwright_cli.mjs', 'open', url, ...headed],
    {
        stdio: 'inherit',
        cwd: process.cwd(),
        env: process.env,
    }
);

child.on('exit', (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 1);
});

