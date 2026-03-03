import { spawn } from 'node:child_process';
import process from 'node:process';

const defaultPort =
    process.env.PORT && process.env.PORT !== '0' ? process.env.PORT : '19000';
let url = process.env.PW_URL || `http://localhost:${defaultPort}/`;
const headed = process.env.PW_HEADED === '1';
const session = process.env.PW_SESSION || `world42-smoke-${Date.now()}`;
const autoServe = process.env.PW_AUTO_SERVE !== '0';

const runPw = (args) =>
    new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['./scripts/playwright_cli.mjs', ...args], {
            stdio: 'inherit',
            cwd: process.cwd(),
            env: {
                ...process.env,
                PW_SESSION: session,
            },
        });

        child.on('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`playwright command interrupted by signal: ${signal}`));
                return;
            }
            if (code !== 0) {
                reject(new Error(`playwright command failed (${args.join(' ')}), exit=${code}`));
                return;
            }
            resolve();
        });
    });

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

function startDevServer() {
    return new Promise((resolve, reject) => {
        const requestedPort = process.env.PW_PORT || defaultPort;
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
                stdio: ['ignore', 'pipe', 'pipe'],
            }
        );

        let resolved = false;
        const onChunk = (line) => {
            const text = String(line);
            process.stdout.write(`[pw-smoke:serve] ${text}`);
            const match = text.match(/https?:\/\/localhost:(\d+)\//);
            if (match && !resolved) {
                resolved = true;
                const detectedUrl = `http://localhost:${match[1]}/`;
                resolve({ child, url: detectedUrl });
            }
        };

        child.stdout?.on('data', onChunk);
        child.stderr?.on('data', onChunk);

        child.on('exit', (code) => {
            if (resolved) return;
            reject(new Error(`dev server exited before ready (code=${code ?? 'null'})`));
        });

        setTimeout(() => {
            if (resolved) return;
            child.kill();
            reject(new Error('timed out waiting for dev server startup'));
        }, 60000);
    });
}

async function main() {
    let devServer = null;

    if (!(await isReachable(url)) && autoServe) {
        console.log(`[pw-smoke] ${url} not reachable, starting dev server...`);
        devServer = await startDevServer();
        url = devServer.url;
        await sleep(500);
    }

    console.log(`[pw-smoke] session=${session}`);
    console.log(`[pw-smoke] url=${url}`);

    try {
        await runPw(['open', url, ...(headed ? ['--headed'] : [])]);
        await runPw(['snapshot']);
        await runPw(['screenshot']);
        console.log('[pw-smoke] completed: open + snapshot + screenshot');
    } finally {
        // Best effort cleanup for this session.
        try {
            await runPw(['close']);
        } catch {
            // ignore close failures
        }
        if (devServer?.child) {
            devServer.child.kill();
        }
    }
}

main().catch((error) => {
    console.error(`[pw-smoke] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
});
