import { spawn, type ChildProcess } from "child_process";
import {
  type InitializeParams,
  type InitializeResult,
  type DefinitionParams,
  type Location,
  type ReferenceParams,
  type Hover,
  type HoverParams,
  type DidOpenTextDocumentParams,
  type TextDocumentIdentifier,
  type Position,
  type LocationLink,
} from "vscode-languageserver-protocol";
import { readFileSync } from "fs";
import { logger } from "../utils/logger.js";

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

export class LspClient {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private buffer = "";
  private contentLength = -1;
  private ready = false;
  private initPromise: Promise<void> | null = null;
  private openedFiles = new Set<string>();

  constructor(
    private rootPath: string,
    private serverCommand: string,
    private serverArgs: string[]
  ) {}

  async start(): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._start();
    return this.initPromise;
  }

  private async _start(): Promise<void> {
    logger.info(`Starting LSP server: ${this.serverCommand} ${this.serverArgs.join(" ")}`);

    this.process = spawn(this.serverCommand, this.serverArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.rootPath,
    });

    this.process.stdout!.on("data", (data: Buffer) => this.handleData(data));
    this.process.stderr!.on("data", (data: Buffer) => {
      // tsserver logs to stderr — ignore or log at debug level
      logger.debug(`LSP stderr: ${data.toString().trim()}`);
    });

    this.process.on("exit", (code) => {
      logger.warn(`LSP server exited with code ${code}`);
      this.ready = false;
      this.process = null;
    });

    // Send initialize
    const initParams: InitializeParams = {
      processId: process.pid,
      rootUri: `file://${this.rootPath}`,
      capabilities: {
        textDocument: {
          definition: { dynamicRegistration: false },
          references: { dynamicRegistration: false },
          hover: { contentFormat: ["plaintext", "markdown"] },
          typeDefinition: { dynamicRegistration: false },
          implementation: { dynamicRegistration: false },
        },
      },
      workspaceFolders: [
        {
          uri: `file://${this.rootPath}`,
          name: "root",
        },
      ],
    };

    const result = (await this.sendRequest("initialize", initParams)) as InitializeResult;
    logger.info(`LSP initialized: ${result.capabilities ? "OK" : "no capabilities"}`);

    // Send initialized notification
    this.sendNotification("initialized", {});
    this.ready = true;
  }

  async stop(): Promise<void> {
    if (this.process) {
      try {
        await this.sendRequest("shutdown", null);
        this.sendNotification("exit", null);
      } catch {
        // ignore errors during shutdown
      }
      this.process.kill();
      this.process = null;
      this.ready = false;
    }
  }

  isReady(): boolean {
    return this.ready;
  }

  private async ensureFileOpen(filePath: string): Promise<void> {
    if (this.openedFiles.has(filePath)) return;

    try {
      const content = readFileSync(filePath, "utf-8");
      const uri = `file://${filePath}`;

      // Determine language ID
      let languageId = "typescript";
      if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs")) {
        languageId = "javascript";
      } else if (filePath.endsWith(".tsx")) {
        languageId = "typescriptreact";
      } else if (filePath.endsWith(".jsx")) {
        languageId = "javascriptreact";
      }

      const params: DidOpenTextDocumentParams = {
        textDocument: {
          uri,
          languageId,
          version: 1,
          text: content,
        },
      };

      this.sendNotification("textDocument/didOpen", params);
      this.openedFiles.add(filePath);
    } catch (err) {
      logger.debug(`Failed to open file in LSP: ${filePath}`, err);
    }
  }

  async getDefinition(
    filePath: string,
    line: number,
    character: number
  ): Promise<Array<{ uri: string; line: number; character: number }>> {
    if (!this.ready) return [];

    await this.ensureFileOpen(filePath);

    const params: DefinitionParams = {
      textDocument: { uri: `file://${filePath}` },
      position: { line: line - 1, character }, // LSP is 0-based
    };

    try {
      const result = await this.sendRequest("textDocument/definition", params);
      return this.normalizeLocations(result);
    } catch (err) {
      logger.debug(`Definition request failed for ${filePath}:${line}:${character}`, err);
      return [];
    }
  }

  async getReferences(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration: boolean = false
  ): Promise<Array<{ uri: string; line: number; character: number }>> {
    if (!this.ready) return [];

    await this.ensureFileOpen(filePath);

    const params: ReferenceParams = {
      textDocument: { uri: `file://${filePath}` },
      position: { line: line - 1, character },
      context: { includeDeclaration },
    };

    try {
      const result = await this.sendRequest("textDocument/references", params);
      return this.normalizeLocations(result);
    } catch (err) {
      logger.debug(`References request failed for ${filePath}:${line}:${character}`, err);
      return [];
    }
  }

  async getHover(
    filePath: string,
    line: number,
    character: number
  ): Promise<string | null> {
    if (!this.ready) return null;

    await this.ensureFileOpen(filePath);

    const params: HoverParams = {
      textDocument: { uri: `file://${filePath}` },
      position: { line: line - 1, character },
    };

    try {
      const result = (await this.sendRequest("textDocument/hover", params)) as Hover | null;
      if (!result || !result.contents) return null;

      if (typeof result.contents === "string") return result.contents;
      if ("value" in result.contents) return result.contents.value;
      if (Array.isArray(result.contents)) {
        return result.contents
          .map((c) => (typeof c === "string" ? c : c.value))
          .join("\n");
      }
      return null;
    } catch (err) {
      logger.debug(`Hover request failed for ${filePath}:${line}:${character}`, err);
      return null;
    }
  }

  async getTypeDefinition(
    filePath: string,
    line: number,
    character: number
  ): Promise<Array<{ uri: string; line: number; character: number }>> {
    if (!this.ready) return [];

    await this.ensureFileOpen(filePath);

    const params: DefinitionParams = {
      textDocument: { uri: `file://${filePath}` },
      position: { line: line - 1, character },
    };

    try {
      const result = await this.sendRequest("textDocument/typeDefinition", params);
      return this.normalizeLocations(result);
    } catch (err) {
      logger.debug(`Type definition request failed for ${filePath}:${line}:${character}`, err);
      return [];
    }
  }

  async getImplementations(
    filePath: string,
    line: number,
    character: number
  ): Promise<Array<{ uri: string; line: number; character: number }>> {
    if (!this.ready) return [];

    await this.ensureFileOpen(filePath);

    try {
      const result = await this.sendRequest("textDocument/implementation", {
        textDocument: { uri: `file://${filePath}` },
        position: { line: line - 1, character },
      });
      return this.normalizeLocations(result);
    } catch (err) {
      logger.debug(`Implementation request failed for ${filePath}:${line}:${character}`, err);
      return [];
    }
  }

  // --- Protocol internals ---

  private normalizeLocations(
    result: unknown
  ): Array<{ uri: string; line: number; character: number }> {
    if (!result) return [];

    const locations: Array<{ uri: string; line: number; character: number }> = [];

    if (Array.isArray(result)) {
      for (const item of result) {
        if ("uri" in item && "range" in item) {
          // Location
          locations.push({
            uri: (item as Location).uri,
            line: (item as Location).range.start.line + 1,
            character: (item as Location).range.start.character,
          });
        } else if ("targetUri" in item) {
          // LocationLink
          locations.push({
            uri: (item as LocationLink).targetUri,
            line: (item as LocationLink).targetRange.start.line + 1,
            character: (item as LocationLink).targetRange.start.character,
          });
        }
      }
    } else if (result && typeof result === "object" && "uri" in result) {
      const loc = result as Location;
      locations.push({
        uri: loc.uri,
        line: loc.range.start.line + 1,
        character: loc.range.start.character,
      });
    }

    return locations;
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });

      const message = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      this.writeMessage(message);

      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP request timed out: ${method}`));
        }
      }, 30000);
    });
  }

  private sendNotification(method: string, params: unknown): void {
    const message = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.writeMessage(message);
  }

  private writeMessage(body: string): void {
    if (!this.process?.stdin?.writable) return;
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    this.process.stdin.write(header + body);
  }

  private handleData(data: Buffer): void {
    this.buffer += data.toString();

    while (true) {
      if (this.contentLength === -1) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const header = this.buffer.substring(0, headerEnd);
        const match = header.match(/Content-Length:\s*(\d+)/i);
        if (!match) {
          this.buffer = this.buffer.substring(headerEnd + 4);
          continue;
        }

        this.contentLength = parseInt(match[1], 10);
        this.buffer = this.buffer.substring(headerEnd + 4);
      }

      if (Buffer.byteLength(this.buffer) < this.contentLength) return;

      const body = this.buffer.substring(0, this.contentLength);
      this.buffer = this.buffer.substring(this.contentLength);
      this.contentLength = -1;

      try {
        const msg = JSON.parse(body);
        if ("id" in msg && this.pending.has(msg.id)) {
          const pending = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
        // Ignore notifications and server-initiated requests
      } catch {
        logger.debug("Failed to parse LSP message");
      }
    }
  }
}
