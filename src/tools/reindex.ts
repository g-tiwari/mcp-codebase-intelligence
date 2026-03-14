import { FileWatcher } from "../indexer/file-watcher.js";

export const reindexTool = {
  name: "reindex",
  description: "Trigger a full re-index of the codebase. Useful after major changes or when results seem stale.",
  inputSchema: {
    type: "object" as const,
    properties: {},
  },
};

export async function handleReindex(watcher: FileWatcher) {
  await watcher.initialIndex();

  return {
    content: [
      {
        type: "text" as const,
        text: "Re-indexing complete.",
      },
    ],
  };
}
