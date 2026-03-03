import { spawn } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const defaultPort =
    process.env.PORT && process.env.PORT !== '0' ? process.env.PORT : '19000';
let url = process.env.PW_URL || `http://localhost:${defaultPort}/`;
const headed = process.env.PW_HEADED === '1';
const session = process.env.PW_SESSION || `world42-smoke-${Date.now()}`;
const runId = process.env.PW_RUN_ID || `world42-smoke-${Date.now()}`;
const autoServe = process.env.PW_AUTO_SERVE !== '0';
const runDir = join(process.cwd(), 'output', 'playwright', runId);
const localPlaywrightCacheDir = join(process.cwd(), '.playwright-cli');

const runPw = (args) =>
    new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['./scripts/playwright_cli.mjs', ...args], {
            stdio: 'inherit',
            cwd: process.cwd(),
            env: {
                ...process.env,
                PW_SESSION: session,
                PW_RUN_ID: runId,
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

function listFilesRecursively(rootDir) {
    const result = [];
    if (!existsSync(rootDir)) return result;

    const walk = (dir, base = '') => {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const rel = base ? `${base}/${entry.name}` : entry.name;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) walk(full, rel);
            else if (entry.isFile()) result.push(rel);
        }
    };

    walk(rootDir);
    return result.sort();
}

function assertSmokeArtifacts() {
    const files = listFilesRecursively(runDir);
    const png = files.filter((f) => f.toLowerCase().endsWith('.png'));
    const snapshots = files.filter((f) => {
        const lower = f.toLowerCase();
        return lower.endsWith('.yml') || lower.endsWith('.yaml');
    });

    if (png.length === 0 || snapshots.length === 0) {
        throw new Error(
            `missing smoke artifacts in ${runDir} (png=${png.length}, snapshots=${snapshots.length})`
        );
    }

    console.log(`[pw-smoke] artifacts=${runDir}`);
    console.log(`[pw-smoke] screenshot=${png[0]}`);
    console.log(`[pw-smoke] snapshot=${snapshots[0]}`);
}

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

    // Ensure smoke artifacts reflect this run only.
    rmSync(localPlaywrightCacheDir, { recursive: true, force: true });

    if (!(await isReachable(url)) && autoServe) {
        console.log(`[pw-smoke] ${url} not reachable, starting dev server...`);
        devServer = await startDevServer();
        url = devServer.url;
        await sleep(500);
    }

    console.log(`[pw-smoke] session=${session}`);
    console.log(`[pw-smoke] runId=${runId}`);
    console.log(`[pw-smoke] url=${url}`);

    try {
        await runPw(['open', url, ...(headed ? ['--headed'] : [])]);
        await runPw(['snapshot']);
        await runPw(['screenshot']);
        assertSmokeArtifacts();
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
