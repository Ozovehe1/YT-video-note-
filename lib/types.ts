export type VideoType = "monologue" | "dialogue";
export type NoteStatus = "processing" | "ready" | "error";
export type ReaderTheme = "paper" | "sepia" | "night" | "contrast";
export type ReaderFont = "read" | "sans";

/** A single content block inside a note section. */
export type NoteBlock =
  | { type: "paragraph"; text: string; speaker?: string; timestamp?: string }
  | { type: "bullet"; text: string; speaker?: string; timestamp?: string }
  | { type: "quote"; text: string; speaker?: string; timestamp?: string };

export interface NoteSection {
  id: string;
  note_id: string;
  order_index: number;
  heading: string;
  timestamp_label: string | null;
  content: NoteBlock[];
  created_at: string;
}

export interface Note {
  id: string;
  user_id: string;
  video_id: string;
  video_url: string;
  title: string;
  channel: string;
  thumbnail: string | null;
  duration_seconds: number | null;
  video_type: VideoType | null;
  speakers: string[];
  status: NoteStatus;
  total_sections: number;
  error_message: string | null;
  created_at: string;
  // Generation progress (present on rows selected with `*`); used to show a live
  // progress bar while a note is still being written.
  chunk_cursor?: number;
  chunk_total?: number;
}

export interface Profile {
  id: string;
  default_theme: ReaderTheme;
  font_family: ReaderFont;
  font_size: number; // px
  reading_width: "narrow" | "default" | "wide";
}

export interface ReadingProgress {
  user_id: string;
  note_id: string;
  last_section_index: number;
  percent: number;
  updated_at: string;
}

export interface SearchResult {
  video_id: string;
  title: string;
  channel: string;
  thumbnail: string;
  duration_label: string | null;
}

/** The structured object the model returns for one generated chunk. */
export interface GeneratedChunk {
  video_type: VideoType;
  speakers: string[];
  sections: {
    heading: string;
    timestamp_label: string | null;
    content: NoteBlock[];
  }[];
}
