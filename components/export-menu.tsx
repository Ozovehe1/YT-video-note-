"use client";

import { FileText, FileType, BookOpen, FileCode } from "lucide-react";

const FORMATS = [
  { key: "pdf", label: "PDF", hint: "Styled & paginated", icon: FileType },
  { key: "docx", label: "Word (.docx)", hint: "Editable", icon: FileText },
  { key: "epub", label: "EPUB", hint: "For e-readers", icon: BookOpen },
  { key: "markdown", label: "Markdown", hint: "Plain .md", icon: FileCode },
] as const;

export function ExportMenu({ noteId, onClose }: { noteId: string; onClose: () => void }) {
  function download(format: string) {
    // The reader chooses the format on demand; each is generated server-side.
    window.location.href = `/api/notes/${noteId}/export?format=${format}`;
    onClose();
  }

  return (
    <div className="w-56 overflow-hidden rounded-xl border border-hairline bg-surface shadow-lift">
      <p className="border-b border-hairline px-4 py-2.5 text-xs font-medium uppercase tracking-wide text-muted">
        Download as
      </p>
      {FORMATS.map((f) => {
        const Icon = f.icon;
        return (
          <button
            key={f.key}
            onClick={() => download(f.key)}
            className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-panel"
          >
            <Icon className="h-4 w-4 flex-none text-oxblood" />
            <span className="flex-1">
              <span className="block text-sm text-ink">{f.label}</span>
              <span className="block text-xs text-muted">{f.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
