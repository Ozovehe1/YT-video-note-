"""Fetch YouTube transcripts and video metadata."""

import os
import re

import requests
from youtube_transcript_api import (
    IpBlocked,
    NoTranscriptFound,
    RequestBlocked,
    TranscriptsDisabled,
    VideoUnavailable,
    YouTubeTranscriptApi,
)
from youtube_transcript_api.proxies import GenericProxyConfig

VIDEO_ID_PATTERNS = [
    r"(?:youtube\.com/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})",
    r"(?:youtu\.be/)([A-Za-z0-9_-]{11})",
    r"(?:youtube\.com/shorts/)([A-Za-z0-9_-]{11})",
    r"(?:youtube\.com/live/)([A-Za-z0-9_-]{11})",
    r"(?:youtube\.com/embed/)([A-Za-z0-9_-]{11})",
]


class TranscriptError(Exception):
    """Raised when a transcript cannot be fetched, with a user-facing message."""


def extract_video_id(url: str) -> str:
    url = url.strip()
    for pattern in VIDEO_ID_PATTERNS:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    # Allow pasting a bare 11-character video ID
    if re.fullmatch(r"[A-Za-z0-9_-]{11}", url):
        return url
    raise TranscriptError("That doesn't look like a valid YouTube URL or video ID.")


def fetch_metadata(video_id: str) -> dict:
    """Get title/channel via YouTube's oEmbed endpoint (no API key needed)."""
    try:
        resp = requests.get(
            "https://www.youtube.com/oembed",
            params={"url": f"https://www.youtube.com/watch?v={video_id}", "format": "json"},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        return {"title": data.get("title", ""), "channel": data.get("author_name", "")}
    except requests.RequestException:
        return {"title": "", "channel": ""}


def _format_timestamp(seconds: float) -> str:
    total = int(seconds)
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours:
        return f"{hours}:{minutes:02d}:{secs:02d}"
    return f"{minutes}:{secs:02d}"


def _build_api() -> YouTubeTranscriptApi:
    # YouTube blocks transcript requests from most cloud-provider IPs. When deploying
    # to a cloud host, set YT_PROXY (e.g. http://user:pass@proxy:port) to route around it.
    proxy_url = os.environ.get("YT_PROXY")
    if proxy_url:
        return YouTubeTranscriptApi(
            proxy_config=GenericProxyConfig(http_url=proxy_url, https_url=proxy_url)
        )
    return YouTubeTranscriptApi()


def fetch_transcript(video_id: str) -> str:
    """Return the full transcript with a [mm:ss] marker at the start of each snippet."""
    api = _build_api()
    try:
        try:
            fetched = api.fetch(video_id, languages=["en", "en-US", "en-GB"])
        except NoTranscriptFound:
            # No English transcript — take whatever exists, translating if possible
            transcript_list = api.list(video_id)
            transcript = next(iter(transcript_list))
            if transcript.language_code[:2] != "en" and transcript.is_translatable:
                transcript = transcript.translate("en")
            fetched = transcript.fetch()
    except TranscriptsDisabled:
        raise TranscriptError(
            "This video has subtitles/captions disabled, so a transcript can't be retrieved."
        )
    except VideoUnavailable:
        raise TranscriptError("This video is unavailable (private, deleted, or region-locked).")
    except (NoTranscriptFound, StopIteration):
        raise TranscriptError("No transcript exists for this video in any language.")
    except (RequestBlocked, IpBlocked):
        raise TranscriptError(
            "YouTube blocked the transcript request from this server's IP (common on cloud "
            "hosts). Run the app locally, or set the YT_PROXY environment variable to a proxy."
        )

    lines = [
        f"[{_format_timestamp(snippet.start)}] {snippet.text.strip()}"
        for snippet in fetched
        if snippet.text.strip()
    ]
    if not lines:
        raise TranscriptError("The transcript for this video is empty.")
    return "\n".join(lines)
