const form = document.getElementById("note-form");
const urlInput = document.getElementById("url-input");
const submitBtn = document.getElementById("submit-btn");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const badgeEl = document.getElementById("badge");
const titleEl = document.getElementById("video-title");
const noteEl = document.getElementById("note");
const copyBtn = document.getElementById("copy-btn");
const downloadBtn = document.getElementById("download-btn");

let currentMarkdown = "";
let currentTitle = "note";

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
  statusEl.classList.toggle("hidden", !message);
}

function renderMarkdown(md) {
  if (window.marked) {
    noteEl.innerHTML = marked.parse(md);
  } else {
    // CDN blocked/offline — fall back to plain text
    const pre = document.createElement("pre");
    pre.textContent = md;
    noteEl.replaceChildren(pre);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;

  submitBtn.disabled = true;
  resultEl.classList.add("hidden");
  setStatus("Fetching transcript and writing your note… this can take a minute for long videos.");

  try {
    const resp = await fetch("/api/notes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data.detail || `Request failed (${resp.status})`);
    }

    currentMarkdown = data.note_markdown;
    currentTitle = data.title || data.video_id;

    badgeEl.textContent = data.video_type === "dialogue"
      ? `Dialogue · ${data.speakers.join(", ")}`
      : "Monologue";
    badgeEl.className = `badge ${data.video_type}`;
    titleEl.textContent = currentTitle;

    renderMarkdown(currentMarkdown);
    setStatus("");
    resultEl.classList.remove("hidden");
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    submitBtn.disabled = false;
  }
});

copyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(currentMarkdown);
  copyBtn.textContent = "Copied!";
  setTimeout(() => (copyBtn.textContent = "Copy markdown"), 1500);
});

downloadBtn.addEventListener("click", () => {
  const blob = new Blob([currentMarkdown], { type: "text/markdown" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${currentTitle.replace(/[^\w\s-]/g, "").trim() || "note"}.md`;
  link.click();
  URL.revokeObjectURL(link.href);
});
