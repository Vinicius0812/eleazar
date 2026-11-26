import { useState } from "react";
import { FolderGit2 } from "lucide-react";

import type { ControlRoomClient } from "../services/contracts.js";

/** The project's own favicon when its folder has one; the folder icon otherwise. */
export function ProjectIcon({ client, projectId, size = 22 }: { client: ControlRoomClient; projectId: string; size?: number }) {
  const url = client.projectIconUrl?.(projectId) ?? "";
  const [failed, setFailed] = useState(false);
  return (
    <span className={`project-icon ${url && !failed ? "has-favicon" : "purple"}`} aria-hidden="true">
      {url && !failed ? <img src={url} alt="" width={size} height={size} onError={() => setFailed(true)} /> : <FolderGit2 size={size} />}
    </span>
  );
}
