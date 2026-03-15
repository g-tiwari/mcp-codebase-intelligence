import { ProjectManager } from "../project-manager.js";

export const listProjectsTool = {
  name: "list_projects",
  description: "List all configured projects, their roots, and index stats. Shows which project is currently active.",
};

export function handleListProjects(pm: ProjectManager) {
  const projects = pm.listProjects();
  if (projects.length === 0) {
    return {
      content: [{ type: "text" as const, text: "No projects configured." }],
    };
  }

  const lines: string[] = [];
  for (const p of projects) {
    const marker = p.active ? " (active)" : "";
    lines.push(`## ${p.name}${marker}`);
    lines.push(`Roots: ${p.roots.join(", ")}`);
    lines.push(`Files: ${p.stats.files}, Symbols: ${p.stats.symbols}, References: ${p.stats.references}, Imports: ${p.stats.imports}`);
    lines.push("");
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
  };
}

export const switchProjectTool = {
  name: "switch_project",
  description: "Switch the active project context. All subsequent tool calls will operate against the selected project's code graph.",
};

export function handleSwitchProject(pm: ProjectManager, args: { project_name: string }) {
  const success = pm.switchProject(args.project_name);
  if (success) {
    const active = pm.active!;
    const stats = active.graph.getStats();
    return {
      content: [{
        type: "text" as const,
        text: `Switched to project "${args.project_name}".\nRoots: ${active.roots.join(", ")}\nFiles: ${stats.files}, Symbols: ${stats.symbols}, References: ${stats.references}`,
      }],
    };
  }

  const available = pm.listProjects().map(p => p.name).join(", ");
  return {
    content: [{
      type: "text" as const,
      text: `Project "${args.project_name}" not found. Available projects: ${available}`,
    }],
  };
}

export const addProjectTool = {
  name: "add_project",
  description: "Add a new project at runtime. Provide a name and one or more root paths. The project is indexed immediately and persisted to ~/.codegraph/config.json.",
};

export async function handleAddProject(pm: ProjectManager, args: { project_name: string; roots?: string; root?: string; include?: string }) {
  const roots = args.roots ? args.roots.split(",").map(r => r.trim()).filter(Boolean) : undefined;
  const include = args.include ? args.include.split(",").map(r => r.trim()).filter(Boolean) : undefined;

  const config: { root?: string; roots?: string[]; include?: string[] } = {};
  if (args.root) config.root = args.root;
  if (roots && roots.length > 0) config.roots = roots;
  if (include && include.length > 0) config.include = include;

  if (!config.root && (!config.roots || config.roots.length === 0)) {
    return {
      content: [{ type: "text" as const, text: "Please provide at least one root path (via 'root' or 'roots' parameter)." }],
    };
  }

  const result = await pm.addProject(args.project_name, config);
  return {
    content: [{ type: "text" as const, text: result }],
  };
}
