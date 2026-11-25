import { LoaderCircle } from "lucide-react";

/** Covers the closest `loading-host` or `loading-area` while it really waits for something, and blocks clicks on it. */
export function LoadingOverlay({ label }: { label: string }) {
  return (
    <div className="loading-overlay" role="status">
      <span><LoaderCircle size={18} className="spinning" aria-hidden="true" /> {label}</span>
    </div>
  );
}
