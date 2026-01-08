// src/server.ts
import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";
import fg from "fast-glob";
import { z } from "zod";
import { applyPatch } from "diff";
import { spawn } from "child_process";
import crypto from "crypto";

// =========================
// 2. types
// =========================
type IndexItem = {
    path: string;
    hash: string;
    imports: string[];
    exports: string[];
    lines: number;
};

// =========================
// 3. 🔴 파일 상단 스코프 캐시 (여기가 핵심)
// =========================
let indexCache: IndexItem[] | null = null;
let indexBuiltAt: string | null = null;
/**
 * ✅ 수정해야 할 부분
 * 1) ROOT_DIR: 대상 프로젝트 루트 경로로 변경
 * 2) AGENT_TOKEN: 인증 토큰 변경 (긴 랜덤 문자열 권장)D:\home\mgunpro
 */
const ROOT_DIR = path.resolve("D:/home/8phone"); // <- 여기를 본인 프로젝트로 변경
const AGENT_TOKEN = "73025532";

/**
 * 최소 보안: 허용 확장자 (원하면 추가/축소)
 * ✅ 수정해야 할 부분: 프로젝트 상황에 맞게 확장자 조정
 */
const ALLOW_EXT = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json",
    ".md",
    ".css",
    ".scss",
    ".html",
    ".yml",
    ".yaml",
    ".env",
    ".env.local",
    ".gitignore",
]);

/**
 * ✅ 수정해야 할 부분
 * 허용할 npm/pnpm 스크립트 이름을 프로젝트 상황에 맞게 조정하세요.
 * (예: build, dev, test, lint, typecheck 등)
 */
const ALLOWED_NPM_SCRIPTS = new Set(["build", "dev", "test", "lint", "typecheck"]);
const ALLOWED_PNPM_SCRIPTS = new Set(["build", "dev", "test", "lint", "typecheck"]);
const ALLOWED_EXEC = new Set(["npm", "pnpm", "tsc", "vitest"]);

/** 경로 탈출 방지 */
function resolveSafe(relPath: string) {
    const normalized = relPath.replaceAll("\\", "/");
    const abs = path.resolve(ROOT_DIR, normalized);
    const root = ROOT_DIR.endsWith(path.sep) ? ROOT_DIR : ROOT_DIR + path.sep;
    if (!abs.startsWith(root) && abs !== ROOT_DIR) {
        throw new Error("Path traversal detected");
    }
    return abs;
}

function checkExt(relPath: string) {
    const ext = path.extname(relPath);
    // .env 같은 파일은 ext가 ""일 수 있어서 예외 처리
    if (ext === "" && (relPath === ".env" || relPath.endsWith(".env.local"))) return;
    if (!ALLOW_EXT.has(ext) && !ALLOW_EXT.has(relPath)) {
        throw new Error(`Extension not allowed: ${ext || relPath}`);
    }
}

/** 간단 인증 미들웨어 */
function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
    const token = req.header("x-agent-token");
    if (!token || token !== AGENT_TOKEN) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    next();
}

function hasDangerousToken(s: string) {
    // spawn를 쓰면 대부분 무력화되지만, 그래도 명백한 위험 토큰은 차단
    return /(\|\||&&|;|\||>|<|`|\$\(|\${)/.test(s);
}

function normalizeExeName(exe: string) {
    const e = exe.toLowerCase();
    // windows에서 npm.cmd / pnpm.cmd로 들어올 수 있음
    if (e.endsWith(".cmd")) return e.slice(0, -4);
    if (e.endsWith(".exe")) return e.slice(0, -4);
    return e;
}

function isAllowedRun(cmd: string[]) {
    if (!cmd.length) return { ok: false as const, reason: "empty cmd" };

    // 인자 자체에 위험 토큰이 있으면 차단
    if (cmd.some(hasDangerousToken)) {
        return { ok: false as const, reason: "dangerous token detected" };
    }

    const exe = normalizeExeName(cmd[0]);
    if (!ALLOWED_EXEC.has(exe)) {
        return { ok: false as const, reason: `exe not allowed: ${exe}` };
    }

    // tsc / vitest는 직접 실행 허용
    if (exe === "tsc" || exe === "vitest") {
        return { ok: true as const, reason: "direct tool allowed" };
    }

    // npm: npm run <script> ... 만 허용
    if (exe === "npm") {
        if (cmd[1] !== "run") return { ok: false as const, reason: "npm only allows: npm run <script>" };
        const script = cmd[2];
        if (!script) return { ok: false as const, reason: "npm script missing" };
        if (!ALLOWED_NPM_SCRIPTS.has(script)) {
            return { ok: false as const, reason: `npm script not allowed: ${script}` };
        }
        return { ok: true as const, reason: "npm script allowed" };
    }

    // pnpm:
    // 1) pnpm run <script> ... 허용 (스크립트 allowlist)
    // 2) pnpm [옵션들] tsc ... / vitest ... 허용 (직접 툴 실행)
    if (exe === "pnpm") {
        let i = 1;
        // pnpm 옵션(-s 등) 스킵
        while (i < cmd.length && cmd[i].startsWith("-")) i++;
        const sub = cmd[i];
        if (!sub) return { ok: false as const, reason: "pnpm subcommand missing" };

        if (sub === "run") {
            const script = cmd[i + 1];
            if (!script) return { ok: false as const, reason: "pnpm script missing" };
            if (!ALLOWED_PNPM_SCRIPTS.has(script)) {
                return { ok: false as const, reason: `pnpm script not allowed: ${script}` };
            }
            return { ok: true as const, reason: "pnpm script allowed" };
        }

        // pnpm tsc ... / pnpm vitest ... 허용 (옵션 뒤에 직접 실행)
        if (sub === "tsc" || sub === "vitest") {
            return { ok: true as const, reason: "pnpm direct tool allowed" };
        }

        return { ok: false as const, reason: `pnpm subcommand not allowed: ${sub}` };
    }

    return { ok: false as const, reason: "blocked by policy" };
}

function spawnRun(cmd: string[], timeoutMs: number, cwd: string) {
    return new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
        const exe = cmd[0];
        const args = cmd.slice(1);
        const child = spawn(exe, args, { cwd, windowsHide: true });

        let stdout = "";
        let stderr = "";

        child.stdout?.on("data", (d) => (stdout += d.toString()));
        child.stderr?.on("data", (d) => (stderr += d.toString()));

        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`Command timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
        });

        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, exitCode: code });
        });
    });
}

function requireIndexCache() {
    if (!indexCache) {
        const err: any = new Error("Index cache not built. Call POST /index first.");
        err.status = 400;
        throw err;
    }
    return indexCache;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

// (기존 /index를 '빌드 + 캐시 저장'으로 쓰기)
app.post("/index", auth, async (_req, res) => {
    try {
        const files = await fg("src/**/*.{ts,tsx,js,jsx}", {
            cwd: ROOT_DIR,
            ignore: ["**/node_modules/**", "**/dist/**"],
        });

        const index: IndexItem[] = [];

        for (const file of files) {
            const abs = resolveSafe(file);
            const content = await fs.readFile(abs, "utf-8");

            const imports = Array.from(
                content.matchAll(/import\s+.*?from\s+['"](.*?)['"]/g),
                (m) => m[1]
            );

            const exports = Array.from(
                content.matchAll(/export\s+(const|function|class|type|interface)\s+(\w+)/g),
                (m) => m[2]
            );

            const hash = crypto.createHash("sha256").update(content).digest("hex");

            index.push({
                path: file,
                hash,
                imports,
                exports,
                lines: content.split("\n").length,
            });
        }

        indexCache = index;
        indexBuiltAt = new Date().toISOString();

        res.json({
            ok: true,
            count: index.length,
            builtAt: indexBuiltAt,
        });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

// 캐시된 인덱스 요약 반환 (payload 가벼움)
app.get("/index/summary", auth, (req, res) => {
    try {
        const idx = requireIndexCache();
        res.json({
            ok: true,
            count: idx.length,
            builtAt: indexBuiltAt,
        });
    } catch (e: any) {
        res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
});

// 인덱스 검색 (핵심)
app.get("/index/search", auth, (req, res) => {
    try {
        const idx = requireIndexCache();

        const pathContains = String(req.query.pathContains || "").trim();
        const exportName = String(req.query.exportName || "").trim();
        const importContains = String(req.query.importContains || "").trim();
        const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));

        let out = idx;

        if (pathContains) {
            const needle = pathContains.toLowerCase();
            out = out.filter((x) => x.path.toLowerCase().includes(needle));
        }
        if (exportName) {
            const needle = exportName.toLowerCase();
            out = out.filter((x) => x.exports.some((e) => e.toLowerCase().includes(needle)));
        }
        if (importContains) {
            const needle = importContains.toLowerCase();
            out = out.filter((x) => x.imports.some((i) => i.toLowerCase().includes(needle)));
        }

        // 결과는 가볍게: path/hash/lines/imports/exports
        res.json({
            ok: true,
            total: out.length,
            limit,
            results: out.slice(0, limit),
        });
    } catch (e: any) {
        res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
});

// 특정 path들의 hash만 뽑아서 변경 감지에 활용
app.get("/index/hash", auth, (req, res) => {
    try {
        const idx = requireIndexCache();
        const pathContains = String(req.query.pathContains || "").trim();

        const filtered = pathContains
            ? idx.filter((x) => x.path.includes(pathContains))
            : idx;

        res.json({
            ok: true,
            count: filtered.length,
            builtAt: indexBuiltAt,
            hashes: filtered.map((x) => ({ path: x.path, hash: x.hash })),
        });
    } catch (e: any) {
        res.status(e?.status || 500).json({ ok: false, error: e?.message || String(e) });
    }
});


/** 상태 확인 */
app.get("/health", (_req, res) => {
    res.json({ ok: true, rootDir: ROOT_DIR, exists: existsSync(ROOT_DIR) });
});

/** 파일 트리 조회 */
app.get("/files", auth, async (req, res) => {
    try {
        const glob = (req.query.glob as string) || "**/*";
        const ignore = [
            "**/node_modules/**",
            "**/.git/**",
            "**/dist/**",
            "**/build/**",
            "**/.next/**",
            "**/.turbo/**",
            "**/.cache/**",
            "**/.vite/**",
            "**/coverage/**",
        ];

        const entries = await fg(glob, {
            cwd: ROOT_DIR,
            dot: true,
            onlyFiles: true,
            unique: true,
            ignore,
        });

        res.json({ ok: true, count: entries.length, files: entries });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

/** 파일 읽기 */
app.get("/file", auth, async (req, res) => {
    try {
        const p = String(req.query.path || "");
        if (!p) return res.status(400).json({ ok: false, error: "path is required" });
        checkExt(p);

        const abs = resolveSafe(p);
        const content = await fs.readFile(abs, "utf-8");

        res.json({ ok: true, path: p, content });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

/** 파일 쓰기 (전체 덮어쓰기) */
app.post("/file", auth, async (req, res) => {
    const schema = z.object({
        path: z.string().min(1),
        content: z.string(),
    });

    try {
        const { path: p, content } = schema.parse(req.body);
        checkExt(p);

        const abs = resolveSafe(p);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf-8");

        res.json({ ok: true, path: p });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

/**
 * unified diff 패치 적용
 */
app.post("/patch", auth, async (req, res) => {
    const schema = z.object({
        path: z.string().min(1),
        patch: z.string().min(1),
        dryRun: z.boolean().optional().default(false),
    });

    try {
        const { path: p, patch, dryRun } = schema.parse(req.body);
        checkExt(p);

        const abs = resolveSafe(p);
        const oldText = await fs.readFile(abs, "utf-8");

        const result = applyPatch(oldText, patch, { fuzzFactor: 2 });

        if (result === false) {
            return res.status(400).json({
                ok: false,
                error: "Patch apply failed",
                hint: "diff 문맥이 현재 파일과 다를 수 있습니다. 최신 파일로 diff를 재생성하세요.",
            });
        }

        if (!dryRun) {
            await fs.writeFile(abs, result, "utf-8");
        }

        res.json({ ok: true, path: p, dryRun, changed: result !== oldText });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

/**
 * 명령 실행 (/run) - allowlist 적용
 * 허용:
 * - npm run <script> (script allowlist)
 * - pnpm run <script> (script allowlist)
 * - pnpm [옵션] (tsc|vitest) ...
 * - tsc ...
 * - vitest ...
 */
app.post("/run", auth, async (req, res) => {
    const schema = z.object({
        cmd: z.array(z.string().min(1)).min(1),
        timeoutMs: z.number().int().positive().optional().default(300000),
    });

    try {
        const { cmd, timeoutMs } = schema.parse(req.body);

        const allowed = isAllowedRun(cmd);
        if (!allowed.ok) {
            return res.status(403).json({
                ok: false,
                error: "Command blocked by allowlist policy",
                reason: allowed.reason,
                allowedExec: Array.from(ALLOWED_EXEC),
                allowedNpmScripts: Array.from(ALLOWED_NPM_SCRIPTS),
                allowedPnpmScripts: Array.from(ALLOWED_PNPM_SCRIPTS),
            });
        }

        const { stdout, stderr, exitCode } = await spawnRun(cmd, timeoutMs, ROOT_DIR);
        res.json({ ok: true, cmd, exitCode, stdout, stderr, policy: allowed.reason });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});


// =========================
// /patch-batch
// =========================
app.post("/patch-batch", auth, async (req, res) => {
    const schema = z.object({
        patches: z.array(
            z.object({
                path: z.string().min(1),
                patch: z.string().min(1),
            })
        ).min(1),
        dryRun: z.boolean().optional().default(false),
    });

    try {
        const { patches, dryRun } = schema.parse(req.body);

        const results: Array<{
            path: string;
            applied: boolean;
            error?: string;
        }> = [];

        for (const item of patches) {
            try {
                checkExt(item.path);
                const abs = resolveSafe(item.path);
                const oldText = await fs.readFile(abs, "utf-8");

                const result = applyPatch(oldText, item.patch, { fuzzFactor: 2 });
                if (result === false) {
                    results.push({ path: item.path, applied: false, error: "patch failed" });
                    continue;
                }

                if (!dryRun) {
                    await fs.writeFile(abs, result, "utf-8");
                }

                results.push({ path: item.path, applied: true });
            } catch (e: any) {
                results.push({ path: item.path, applied: false, error: e?.message || String(e) });
            }
        }

        res.json({
            ok: true,
            dryRun,
            total: patches.length,
            success: results.filter(r => r.applied).length,
            results,
        });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

// =========================
// /index (파일 요약 인덱싱)
// =========================
app.post("/index", auth, async (_req, res) => {
    try {
        const files = await fg("src/**/*.{ts,tsx,js,jsx}", {
            cwd: ROOT_DIR,
            ignore: ["**/node_modules/**", "**/dist/**"],
        });

        const index = [];

        for (const file of files) {
            const abs = resolveSafe(file);
            const content = await fs.readFile(abs, "utf-8");

            const imports = Array.from(
                content.matchAll(/import\s+.*?from\s+['"](.*?)['"]/g),
                m => m[1]
            );

            const exports = Array.from(
                content.matchAll(/export\s+(const|function|class|type|interface)\s+(\w+)/g),
                m => m[2]
            );

            const hash = crypto.createHash("sha256").update(content).digest("hex");

            index.push({
                path: file,
                hash,
                imports,
                exports,
                lines: content.split("\n").length,
            });
        }

        res.json({
            ok: true,
            count: index.length,
            index,
        });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

// app.use(cors()); 아래쯤에 추가 추천
app.use((req, _res, next) => {
    console.log(`[REQ] ${new Date().toISOString()} ${req.method} ${req.url} from ${req.ip}`);
    next();
});
// ===== [ADD] GET /grep?q=...&glob=...&limit=... =====
app.get("/grep", auth, async (req, res) => {
    try {
        const q = String(req.query.q || "").trim();
        const glob = String(req.query.glob || "src/**/*.{ts,tsx,js,jsx}").trim();
        const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));

        if (!q) {
            return res.status(400).json({ ok: false, error: "Missing q" });
        }

        const files = await fg(glob, {
            cwd: ROOT_DIR,
            ignore: ["**/node_modules/**", "**/dist/**"],
        });

        const results: Array<{
            path: string;
            matches: Array<{ line: number; text: string }>;
        }> = [];

        const needle = q.toLowerCase();

        for (const file of files) {
            if (results.length >= limit) break;

            const abs = resolveSafe(file);
            const content = await fs.readFile(abs, "utf-8");
            const lines = content.split(/\r?\n/);

            const matches: Array<{ line: number; text: string }> = [];
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].toLowerCase().includes(needle)) {
                    // 앞뒤 컨텍스트 1줄 포함
                    const start = Math.max(0, i - 1);
                    const end = Math.min(lines.length - 1, i + 1);

                    for (let j = start; j <= end; j++) {
                        matches.push({ line: j + 1, text: lines[j] });
                    }

                    // 한 파일에서 매치가 너무 많아지면 컷
                    if (matches.length > 12) break;
                }
            }

            if (matches.length) {
                results.push({ path: file, matches });
            }
        }

        res.json({
            ok: true,
            q,
            glob,
            totalFiles: files.length,
            returned: results.length,
            results,
        });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

const PORT = Number(process.env.PORT || 4312);
app.listen(PORT, () => {
    console.log(`[local-file-agent] running on http://localhost:${PORT}`);
    console.log(`[local-file-agent] ROOT_DIR=${ROOT_DIR}`);
});
