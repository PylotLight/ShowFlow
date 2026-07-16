import { db } from "../db";
import { getDebugLogs } from "../core/debug";
import type { SystemManager } from "../core/system_manager";
import { json, errorResponse } from "./_shared";
import path from "node:path";
import fs from "node:fs";

export function miscRoutes(systemManager: SystemManager) {
  return {

    "/api/feedback": {
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = (await req.json()) as {
            message: string;
            screenshot?: string;
            url?: string;
            includeDebugLogs?: boolean;
            userAgent?: string;
          };

          if (!body.message?.trim()) {
            return errorResponse("Message is required");
          }

          const token = process.env.GITHUB_TOKEN;
          const repo = process.env.GITHUB_REPO;

          if (!token || !repo) {
            return errorResponse("Feedback is not configured — set GITHUB_TOKEN and GITHUB_REPO environment variables", 501);
          }

          const lines = [
            `**Description**`,
            body.message,
            "",
            `**URL**  ${body.url || "N/A"}`,
            `**Browser**  ${body.userAgent || "N/A"}`,
            `**Time**  ${new Date().toISOString()}`,
          ];

          if (body.screenshot) {
            lines.push("", "**Screenshot**", `![screenshot](data:image/png;base64,${body.screenshot})`);
          }

          if (body.includeDebugLogs) {
            const logs = getDebugLogs({ limit: 50 });
            if (logs.length > 0) {
              lines.push("", "**Debug Logs**", "```", JSON.stringify(logs, null, 2).slice(0, 8000), "```");
            }
          }

          const res = await fetch(`https://api.github.com/repos/${repo}/issues`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              "User-Agent": "showflow-feedback",
            },
            body: JSON.stringify({
              title: `Feedback: ${body.message.slice(0, 80)}${body.message.length > 80 ? "…" : ""}`,
              body: lines.join("\n"),
              labels: ["feedback"],
            }),
          });

          if (!res.ok) {
            const err = await res.text();
            console.error("[feedback] GitHub API error:", res.status, err);
            return errorResponse(`GitHub API error: ${res.status}`, 502);
          }

          const issue = await res.json();
          return json({ url: issue.html_url, number: issue.number });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/manual-import/list": {
      async GET() {
        try {
          const files = await systemManager.listManualImportFiles();
          return json(files);
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/manual-import/import": {
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = (await req.json()) as { files: string[] };
          if (!Array.isArray(body.files) || body.files.length === 0) {
            return errorResponse('files array is required');
          }
          const results = [];
          for (const filename of body.files) {
            const result = await systemManager.forceImportFile(filename);
            results.push({ filename, ...result });
          }
          return json({ results });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/manual-import/delete": {
      async POST(req: Request & { params: Record<string, string> }) {
        try {
          const body = (await req.json()) as { files: string[] };
          if (!Array.isArray(body.files) || body.files.length === 0) {
            return errorResponse('files array is required');
          }
          const results = [];
          for (const filename of body.files) {
            const result = await systemManager.deleteWatchFile(filename);
            results.push({ filename, ...result });
          }
          return json({ results });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/manual-import/count": {
      async GET() {
        try {
          const count = await systemManager.countWatchFiles();
          return json({ count });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

    "/api/files/browse": {
      GET(req: Request & { params: Record<string, string> }) {
        try {
          const url = new URL(req.url);
          const rawPath = url.searchParams.get("path") || "/";
          const dirPath = path.resolve(rawPath);
          if (!fs.existsSync(dirPath)) return json({ error: "Path does not exist" }, { status: 404 });
          const stat = fs.statSync(dirPath);
          if (!stat.isDirectory()) return json({ error: "Path is not a directory" }, { status: 400 });
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          const directories = entries.filter(e => e.isDirectory()).map(e => e.name).sort((a, b) => a.localeCompare(b));
          const parentPath = path.dirname(dirPath);
          return json({
            path: dirPath,
            directories,
            parentPath: parentPath === dirPath ? null : parentPath,
          });
        } catch (err) {
          return errorResponse(err, 500);
        }
      },
    },

  };
}
