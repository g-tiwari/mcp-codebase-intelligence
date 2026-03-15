import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import path from "path";
import { initializeDatabase } from "./graph/schema.js";
import { CodeGraph } from "./graph/code-graph.js";
import { FileWatcher } from "./indexer/file-watcher.js";
import { LspManager } from "./lsp/lsp-manager.js";
import { logger } from "./utils/logger.js";

export interface ProjectConfig {
  root?: string;
  roots?: string[];
  include?: string[];
}

export interface ResolvedProject {
  name: string;
  roots: string[];        // all absolute paths to index
  graph: CodeGraph;
  watcher: FileWatcher;
  lspManager: LspManager;
  db: ReturnType<typeof initializeDatabase>;
}

interface ConfigFile {
  projects: Record<string, ProjectConfig>;
}

const CODEGRAPH_DIR = path.join(
  process.env.HOME || process.env.USERPROFILE || "/tmp",
  ".codegraph"
);

/**
 * Detect git root by walking up from cwd
 */
function detectGitRoot(startDir: string): string | null {
  let dir = path.resolve(startDir);
  while (true) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Detect monorepo workspace packages and return include paths
 */
function detectMonorepoIncludes(root: string): string[] | null {
  // pnpm-workspace.yaml
  const pnpmPath = path.join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpmPath)) {
    try {
      const content = readFileSync(pnpmPath, "utf-8");
      const packages: string[] = [];
      // Simple YAML parsing — extract packages array entries
      let inPackages = false;
      for (const line of content.split("\n")) {
        if (line.match(/^packages\s*:/)) {
          inPackages = true;
          continue;
        }
        if (inPackages) {
          const match = line.match(/^\s+-\s+['"]?([^'"]+)['"]?\s*$/);
          if (match) {
            packages.push(match[1].replace(/\/\*$/, ""));
          } else if (line.match(/^\S/)) {
            break; // next top-level key
          }
        }
      }
      if (packages.length > 0) {
        logger.info(`Detected pnpm workspace: ${packages.length} package patterns`);
        return packages;
      }
    } catch { /* ignore parse errors */ }
  }

  // lerna.json
  const lernaPath = path.join(root, "lerna.json");
  if (existsSync(lernaPath)) {
    try {
      const config = JSON.parse(readFileSync(lernaPath, "utf-8"));
      const packages = (config.packages || ["packages/*"]).map((p: string) => p.replace(/\/\*$/, ""));
      logger.info(`Detected lerna workspace: ${packages.length} package patterns`);
      return packages;
    } catch { /* ignore */ }
  }

  // nx.json (check for workspace layout)
  if (existsSync(path.join(root, "nx.json"))) {
    const pkgJson = path.join(root, "package.json");
    if (existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJson, "utf-8"));
        if (pkg.workspaces) {
          const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages || [];
          const packages = ws.map((p: string) => p.replace(/\/\*$/, ""));
          logger.info(`Detected nx workspace: ${packages.length} package patterns`);
          return packages;
        }
      } catch { /* ignore */ }
    }
  }

  // go.work
  const goWorkPath = path.join(root, "go.work");
  if (existsSync(goWorkPath)) {
    try {
      const content = readFileSync(goWorkPath, "utf-8");
      const dirs: string[] = [];
      let inUse = false;
      for (const line of content.split("\n")) {
        if (line.match(/^use\s*\(/)) { inUse = true; continue; }
        if (inUse && line.match(/^\)/)) { inUse = false; continue; }
        if (inUse) {
          const dir = line.trim();
          if (dir && !dir.startsWith("//")) dirs.push(dir);
        }
        // single-line: use ./foo
        const single = line.match(/^use\s+(\S+)/);
        if (single && !line.includes("(")) dirs.push(single[1]);
      }
      if (dirs.length > 0) {
        logger.info(`Detected Go workspace: ${dirs.length} modules`);
        return dirs;
      }
    } catch { /* ignore */ }
  }

  // Cargo.toml with [workspace]
  const cargoPath = path.join(root, "Cargo.toml");
  if (existsSync(cargoPath)) {
    try {
      const content = readFileSync(cargoPath, "utf-8");
      if (content.includes("[workspace]")) {
        const members: string[] = [];
        let inMembers = false;
        for (const line of content.split("\n")) {
          if (line.match(/^members\s*=/)) {
            inMembers = true;
            // Check for inline array: members = ["foo", "bar"]
            const inline = line.match(/\[([^\]]+)\]/);
            if (inline) {
              inline[1].split(",").forEach(m => {
                const trimmed = m.trim().replace(/['"]/g, "").replace(/\/\*$/, "");
                if (trimmed) members.push(trimmed);
              });
              inMembers = false;
            }
            continue;
          }
          if (inMembers) {
            if (line.match(/^\s*\]/)) { inMembers = false; continue; }
            const m = line.match(/['"]([^'"]+)['"]/);
            if (m) members.push(m[1].replace(/\/\*$/, ""));
          }
        }
        if (members.length > 0) {
          logger.info(`Detected Cargo workspace: ${members.length} members`);
          return members;
        }
      }
    } catch { /* ignore */ }
  }

  // npm/yarn workspaces (package.json)
  const pkgJsonPath = path.join(root, "package.json");
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
      if (pkg.workspaces) {
        const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages || [];
        if (ws.length > 0) {
          const packages = ws.map((p: string) => p.replace(/\/\*$/, ""));
          logger.info(`Detected npm/yarn workspace: ${packages.length} package patterns`);
          return packages;
        }
      }
    } catch { /* ignore */ }
  }

  return null;
}

/**
 * Find .codegraph.json walking up from startDir to git root
 */
function findLocalConfig(startDir: string): { config: ConfigFile; dir: string } | null {
  let dir = path.resolve(startDir);
  const gitRoot = detectGitRoot(startDir);
  const stopAt = gitRoot ? path.dirname(gitRoot) : path.parse(dir).root;

  while (true) {
    const configPath = path.join(dir, ".codegraph.json");
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, "utf-8"));
        logger.info(`Loaded config from ${configPath}`);
        return { config, dir };
      } catch (err) {
        logger.warn(`Invalid .codegraph.json at ${configPath}`, err);
      }
    }
    if (dir === stopAt || dir === path.parse(dir).root) break;
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Load user-level config from ~/.codegraph/config.json
 */
function loadUserConfig(): ConfigFile | null {
  const configPath = path.join(CODEGRAPH_DIR, "config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      logger.info(`Loaded user config from ${configPath}`);
      return config;
    } catch (err) {
      logger.warn(`Invalid config at ${configPath}`, err);
    }
  }
  return null;
}

/**
 * Resolve a ProjectConfig into absolute root paths
 */
function resolveRoots(config: ProjectConfig, baseDir?: string): string[] {
  const roots: string[] = [];

  if (config.root) {
    const absRoot = path.resolve(config.root);
    if (config.include && config.include.length > 0) {
      // Monorepo scoped — each include becomes a root
      for (const inc of config.include) {
        const absInc = path.resolve(absRoot, inc);
        if (existsSync(absInc)) roots.push(absInc);
        else logger.warn(`Include path not found: ${absInc}`);
      }
    } else {
      roots.push(absRoot);
    }
  }

  if (config.roots) {
    for (const r of config.roots) {
      const absRoot = path.resolve(r);
      if (existsSync(absRoot)) roots.push(absRoot);
      else logger.warn(`Root not found: ${absRoot}`);
    }
  }

  return [...new Set(roots)]; // deduplicate
}

/**
 * Get DB path for a project
 */
function getDbPath(projectName: string): string {
  const graphsDir = path.join(CODEGRAPH_DIR, "graphs");
  mkdirSync(graphsDir, { recursive: true });
  return path.join(graphsDir, `${projectName}.db`);
}

/**
 * Initialize a resolved project (DB, graph, watcher, LSP)
 */
function initProject(name: string, roots: string[]): ResolvedProject {
  const dbPath = getDbPath(name);
  const db = initializeDatabase(dbPath);
  const graph = new CodeGraph(db);
  const watcher = new FileWatcher(roots, graph);
  // LSP uses the first root as the workspace root
  const lspManager = new LspManager(roots[0]);

  return { name, roots, graph, watcher, lspManager, db };
}

export class ProjectManager {
  private projects = new Map<string, ResolvedProject>();
  private _activeProject: string | null = null;

  /**
   * Resolve configuration and initialize all projects
   */
  async initialize(): Promise<void> {
    const cwd = process.cwd();
    let projectConfigs: Record<string, ProjectConfig> = {};

    // 1. Check for local .codegraph.json
    const localConfig = findLocalConfig(cwd);
    if (localConfig) {
      for (const [name, config] of Object.entries(localConfig.config.projects || {})) {
        // If root is relative or not set, resolve relative to config file location
        if (config.root && !path.isAbsolute(config.root)) {
          config.root = path.resolve(localConfig.dir, config.root);
        }
        if (!config.root && !config.roots) {
          config.root = localConfig.dir;
        }
        projectConfigs[name] = config;
      }
    }

    // 2. Check user-level config (merge, local takes precedence)
    const userConfig = loadUserConfig();
    if (userConfig) {
      for (const [name, config] of Object.entries(userConfig.projects || {})) {
        if (!projectConfigs[name]) {
          projectConfigs[name] = config;
        }
      }
    }

    // 3. Check PROJECT_ROOTS env
    if (Object.keys(projectConfigs).length === 0 && process.env.PROJECT_ROOTS) {
      const roots = process.env.PROJECT_ROOTS.split(",").map(r => r.trim()).filter(Boolean);
      projectConfigs["default"] = { roots };
    }

    // 4. Check PROJECT_ROOT env (backwards compat)
    if (Object.keys(projectConfigs).length === 0 && process.env.PROJECT_ROOT) {
      projectConfigs["default"] = { root: process.env.PROJECT_ROOT };
    }

    // 5. Auto-detect from cwd
    if (Object.keys(projectConfigs).length === 0) {
      const gitRoot = detectGitRoot(cwd);
      const root = gitRoot || cwd;

      // Check for monorepo markers
      const includes = detectMonorepoIncludes(root);
      if (includes) {
        projectConfigs["default"] = { root, include: includes };
      } else {
        projectConfigs["default"] = { root };
      }
    }

    // Resolve and initialize all projects
    for (const [name, config] of Object.entries(projectConfigs)) {
      const roots = resolveRoots(config);
      if (roots.length === 0) {
        logger.warn(`Project "${name}" has no valid roots, skipping`);
        continue;
      }

      // Validate all roots exist and are directories
      for (const root of roots) {
        if (!existsSync(root) || !statSync(root).isDirectory()) {
          logger.warn(`Project "${name}": root is not a valid directory: ${root}`);
        }
      }

      const project = initProject(name, roots.filter(r => existsSync(r) && statSync(r).isDirectory()));
      this.projects.set(name, project);
      logger.info(`Project "${name}": ${project.roots.length} root(s) — ${project.roots.join(", ")}`);
    }

    // Auto-select active project
    if (this.projects.size === 1) {
      this._activeProject = this.projects.keys().next().value!;
    } else if (this.projects.size > 1) {
      // Match cwd against project roots
      const cwdResolved = path.resolve(cwd);
      let bestMatch: string | null = null;
      let bestLen = 0;
      for (const [name, project] of this.projects) {
        for (const root of project.roots) {
          if (cwdResolved.startsWith(root) && root.length > bestLen) {
            bestMatch = name;
            bestLen = root.length;
          }
        }
      }
      this._activeProject = bestMatch || this.projects.keys().next().value!;
    }

    if (this._activeProject) {
      logger.info(`Active project: "${this._activeProject}"`);
    }
  }

  /**
   * Index and start watching all projects
   */
  async startAll(): Promise<void> {
    for (const [name, project] of this.projects) {
      logger.info(`Indexing project "${name}"...`);
      await project.watcher.initialIndex();
      project.watcher.startWatching();

      // Start LSP in background
      project.lspManager.start().then(() => {
        const servers = project.lspManager.getActiveServers();
        if (servers.length > 0) {
          logger.info(`Project "${name}" LSP: ${servers.join(", ")}`);
        }
      }).catch((err) => {
        logger.warn(`Project "${name}" LSP startup failed (non-fatal)`, err);
      });
    }
  }

  /**
   * Get the active project
   */
  get active(): ResolvedProject | null {
    if (!this._activeProject) return null;
    return this.projects.get(this._activeProject) || null;
  }

  get activeProjectName(): string | null {
    return this._activeProject;
  }

  /**
   * Switch active project
   */
  switchProject(name: string): boolean {
    if (this.projects.has(name)) {
      this._activeProject = name;
      logger.info(`Switched to project "${name}"`);
      return true;
    }
    return false;
  }

  /**
   * List all projects with stats
   */
  listProjects(): Array<{ name: string; active: boolean; roots: string[]; stats: ReturnType<CodeGraph["getStats"]> }> {
    const result = [];
    for (const [name, project] of this.projects) {
      result.push({
        name,
        active: name === this._activeProject,
        roots: project.roots,
        stats: project.graph.getStats(),
      });
    }
    return result;
  }

  /**
   * Add a project at runtime and persist to user config
   */
  async addProject(name: string, config: ProjectConfig): Promise<string> {
    if (this.projects.has(name)) {
      return `Project "${name}" already exists. Use switch_project to activate it.`;
    }

    const roots = resolveRoots(config);
    if (roots.length === 0) {
      return `No valid roots found for project "${name}".`;
    }

    const project = initProject(name, roots);
    this.projects.set(name, project);

    // Index it
    await project.watcher.initialIndex();
    project.watcher.startWatching();
    project.lspManager.start().catch(() => {});

    // Persist to user config
    const userConfigPath = path.join(CODEGRAPH_DIR, "config.json");
    let userConfig: ConfigFile = { projects: {} };
    if (existsSync(userConfigPath)) {
      try {
        userConfig = JSON.parse(readFileSync(userConfigPath, "utf-8"));
      } catch { /* start fresh */ }
    }
    userConfig.projects[name] = config;
    mkdirSync(CODEGRAPH_DIR, { recursive: true });
    writeFileSync(userConfigPath, JSON.stringify(userConfig, null, 2) + "\n");

    // Auto-switch to new project
    this._activeProject = name;

    const stats = project.graph.getStats();
    return `Project "${name}" added and activated. ${stats.files} files, ${stats.symbols} symbols indexed.`;
  }

  /**
   * Get all root paths for the active project (for descriptions, etc.)
   */
  getActiveRoots(): string[] {
    return this.active?.roots || [];
  }

  /**
   * Get the primary root (first root) of the active project
   */
  getPrimaryRoot(): string | null {
    const roots = this.getActiveRoots();
    return roots.length > 0 ? roots[0] : null;
  }

  /**
   * Shut down all projects
   */
  async shutdown(): Promise<void> {
    for (const [name, project] of this.projects) {
      logger.info(`Shutting down project "${name}"...`);
      await project.watcher.stop();
      await project.lspManager.stop();
      project.db.close();
    }
  }
}
