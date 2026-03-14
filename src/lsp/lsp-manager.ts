import { existsSync } from "fs";
import { execFile } from "child_process";
import path from "path";
import { LspClient } from "./lsp-client.js";
import { logger } from "../utils/logger.js";

interface LspServerConfig {
  id: string;
  command: string;
  args: string[];
  extensions: string[];
  detect: (rootPath: string) => boolean;
}

const KNOWN_SERVERS: LspServerConfig[] = [
  {
    id: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    extensions: [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"],
    detect: (root) =>
      existsSync(path.join(root, "tsconfig.json")) ||
      existsSync(path.join(root, "jsconfig.json")) ||
      existsSync(path.join(root, "package.json")),
  },
];

export class LspManager {
  private clients = new Map<string, LspClient>();
  private extMap = new Map<string, string>(); // extension -> server id

  constructor(private rootPath: string) {}

  async start(): Promise<void> {
    for (const config of KNOWN_SERVERS) {
      if (!config.detect(this.rootPath)) {
        logger.debug(`LSP ${config.id}: skipped (no project markers found)`);
        continue;
      }

      // Check if the server binary is available (direct or via npx)
      let command = config.command;
      let args = config.args;
      const available = await this.isCommandAvailable(config.command);
      if (!available) {
        // Try via npx
        const npxAvailable = await this.isCommandAvailable("npx");
        if (npxAvailable) {
          command = "npx";
          args = [config.command, ...config.args];
          logger.info(`LSP ${config.id}: using npx to run ${config.command}`);
        } else {
          logger.info(`LSP ${config.id}: ${config.command} not found, skipping`);
          continue;
        }
      }

      try {
        const client = new LspClient(this.rootPath, command, args);
        await client.start();
        this.clients.set(config.id, client);
        for (const ext of config.extensions) {
          this.extMap.set(ext, config.id);
        }
        logger.info(`LSP ${config.id}: started`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`LSP ${config.id}: failed to start — ${msg}`);
      }
    }
  }

  getClientForFile(filePath: string): LspClient | undefined {
    for (const [ext, serverId] of this.extMap) {
      if (filePath.endsWith(ext)) {
        return this.clients.get(serverId);
      }
    }
    return undefined;
  }

  hasAnyClient(): boolean {
    return this.clients.size > 0;
  }

  getActiveServers(): string[] {
    return Array.from(this.clients.keys());
  }

  async stop(): Promise<void> {
    for (const [id, client] of this.clients) {
      try {
        await client.stop();
        logger.info(`LSP ${id}: stopped`);
      } catch (err) {
        logger.debug(`LSP ${id}: error during stop`, err);
      }
    }
    this.clients.clear();
  }

  private isCommandAvailable(command: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile("which", [command], (err) => {
        resolve(!err);
      });
    });
  }
}
