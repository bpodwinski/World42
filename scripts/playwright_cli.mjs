import { spawn } from 'node:child_process';
import {
    cpSync,
    existsSync,
    mkdirSync,
    readdirSync,
    writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);

if (args.length === 0) {
    console.error('Usage: npm run pw -- <playwright-cli command> [args]');
    console.error('Example: npm run pw -- open http://localhost:19000 --headed');
    process.exit(1);
}

const outputDir = join(process.cwd(), 'output', 'playwright');
const sourceDir = join(process.cwd(), '.playwright-cli');
const runId =
    process.env.PW_RUN_ID?.trim() ||
    `pw-${Date.now()}`;
const runDir = join(outputDir, runId);

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

function exportArtifacts(commandExitCode) {
    mkdirSync(runDir, { recursive: true });

    let copiedArtifactsRoot = null;
    if (existsSync(sourceDir)) {
        copiedArtifactsRoot = join(runDir, '.playwright-cli');
        cpSync(sourceDir, copiedArtifactsRoot, { recursive: true, force: true });
    }

    const artifacts = copiedArtifactsRoot
        ? listFilesRecursively(copiedArtifactsRoot).map((p) => `.playwright-cli/${p}`)
        : [];

    const summary = {
        runId,
        command: args,
        exitCode: commandExitCode,
        createdAt: new Date().toISOString(),
        artifacts,
    };

    writeFileSync(join(runDir, 'run-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    writeFileSync(join(outputDir, 'latest-run.txt'), `${runId}\n`, 'utf8');

    console.log(`[pw] runId=${runId}`);
    console.log(`[pw] artifacts=${runDir}`);
}

child.on('exit', (code, signal) => {
    const exitCode = code ?? 1;

    try {
        exportArtifacts(exitCode);
    } catch (error) {
        console.error(
            `[pw] artifact export failed: ${error instanceof Error ? error.message : String(error)}`
        );
        if (!signal) {
            process.exit(1);
            return;
        }
    }

    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(exitCode);
});
