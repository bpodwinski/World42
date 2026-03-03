import { spawn } from 'node:child_process';
import process from 'node:process';

const defaultPort = process.env.PORT && process.env.PORT !== '0'
    ? process.env.PORT
    : '19000';
let url = process.env.PW_URL || `http://localhost:${defaultPort}/`;
const headed = process.env.PW_HEADED === '0' ? [] : ['--headed'];
const autoServe = process.env.PW_AUTO_SERVE !== '0';

function inferPortFromUrl(targetUrl) {
    try {
        const parsed = new URL(targetUrl);
        if (parsed.port) return parsed.port;
    } catch {
        // ignore
    }
    return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function isReachable(target) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
        const response = await fetch(target, {
            method: 'GET',
            signal: controller.signal,
        });
        return response.ok || response.status > 0;
    } catch {
        return false;
    } finally {
        clearTimeout(timeout);
    }
}

function startDevServerBackground() {
    const requestedPort = process.env.PW_PORT || inferPortFromUrl(url) || defaultPort;
    const child = spawn(
        process.execPath,
        ['./node_modules/@rspack/cli/bin/rspack.js', 'serve'],
        {
            cwd: process.cwd(),
            env: {
                ...process.env,
                NODE_ENV: 'development',
                DEV_HOT: process.env.DEV_HOT || '0',
                PORT: requestedPort,
            },
            detached: true,
            stdio: 'ignore',
        }
    );
    child.unref();
    return child.pid;
}

async function main() {
    if (!(await isReachable(url)) && autoServe) {
        console.log(`[pw-open] ${url} not reachable, starting dev server...`);
        const pid = startDevServerBackground();
        console.log(`[pw-open] dev server started in background (pid=${pid ?? 'n/a'})`);

        const timeoutMs = 60000;
        const startedAt = Date.now();
        while (!(await isReachable(url))) {
            if (Date.now() - startedAt > timeoutMs) {
                throw new Error(`dev server did not become reachable at ${url} within ${timeoutMs}ms`);
            }
            await sleep(500);
        }
        console.log(`[pw-open] dev server reachable at ${url}`);
    }

    await new Promise((resolve, reject) => {
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
                reject(new Error(`playwright open interrupted by signal: ${signal}`));
                return;
            }
            if ((code ?? 1) !== 0) {
                reject(new Error(`playwright open failed with exit code ${code ?? 1}`));
                return;
            }
            resolve();
        });
    });
}

main().catch((error) => {
    console.error(`[pw-open] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
