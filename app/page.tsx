import Link from "next/link";
import { Search, FileText, BookOpen, Download } from "lucide-react";
import { HeroSearch } from "@/components/hero-search";
import { Reveal } from "@/components/reveal";

export default function Home() {
  return (
    <main className="mx-auto max-w-6xl px-5 sm:px-8">
      {/* Hero */}
      <section className="grid grid-cols-1 items-center gap-10 pb-16 pt-14 md:grid-cols-[1.1fr_0.9fr] md:gap-14 md:pb-24 md:pt-20">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.18em] text-oxblood">
            Watch less · Read more
          </p>
          <h1 className="mt-4 font-display text-[2.7rem] font-semibold leading-[1.02] tracking-[-0.025em] text-ink sm:text-[3.5rem]">
            Every video, as something you <em className="italic text-oxblood">read</em>.
          </h1>
          <p className="mt-5 max-w-lg font-read text-lg leading-relaxed text-muted">
            Search a talk or drop a link. Verbatim writes a faithful, structured note that mirrors
            the video — word for word, in the order it was said. Read it, theme it, take it anywhere.
          </p>
          <div className="mt-8 max-w-xl">
            <HeroSearch />
            <p className="mt-3 pl-1 text-sm text-muted">
              Free to start · works with any YouTube video.
            </p>
          </div>
        </div>

        {/* Reader preview card */}
        <Reveal className="relative">
          <div className="rounded-2xl border border-hairline bg-panel p-7 shadow-lift">
            <p className="font-mono text-[0.66rem] uppercase tracking-[0.14em] text-oxblood">
              Monologue · 1 speaker
            </p>
            <h3 className="mt-2.5 font-display text-xl font-semibold tracking-tight text-ink">
              Why memory beats recall{" "}
              <span className="font-mono text-xs font-normal text-muted">08:14</span>
            </h3>
            <p className="prose-read reader-body mt-3.5 text-[1.02rem] text-ink/90">
              The speaker draws a line between storing information and being able to act on it.{" "}
              <span className="font-semibold text-oxblood">“</span>Recall is expensive; recognition
              is cheap<span className="font-semibold text-oxblood">”</span> — and the whole design
              follows from that.
            </p>
            <blockquote className="prose-read mt-4 border-l-[3px] border-oxblood pl-4 text-[1rem] italic text-muted">
              “You don’t need to remember the video. You need to find the exact moment again.”
            </blockquote>
            <div className="mt-5 flex items-center justify-between font-mono text-xs text-muted">
              <span>‹ Prev</span>
              <span>Page 3 / 12</span>
              <span>Next ›</span>
            </div>
          </div>
        </Reveal>
      </section>

      {/* How it works */}
      <section id="how" className="scroll-mt-24 border-t border-hairline py-16 md:py-20">
        <h2 className="font-display text-3xl font-semibold tracking-tight text-ink">
          From link to reading, in four steps
        </h2>
        <div className="mt-10 grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
          <Step
            n="01"
            icon={<Search className="h-5 w-5" />}
            title="Find it"
            body="Search a title or paste a link — no need to hunt down the URL yourself."
          />
          <Step
            n="02"
            icon={<FileText className="h-5 w-5" />}
            title="We transcribe"
            body="The full timestamped transcript is pulled and split so nothing gets summarized away."
          />
          <Step
            n="03"
            icon={<BookOpen className="h-5 w-5" />}
            title="We write it out"
            body="Monologue or dialogue is detected, speakers attributed, and a faithful note is written in order."
          />
          <Step
            n="04"
            icon={<Download className="h-5 w-5" />}
            title="Read or export"
            body="Read it in a themeable reader that remembers your place — or export to PDF, DOCX, Markdown, EPUB."
          />
        </div>
      </section>

      {/* Faithfulness note */}
      <section className="border-t border-hairline py-16 md:py-20">
        <div className="grid grid-cols-1 gap-8 md:grid-cols-[0.9fr_1.1fr] md:gap-14">
          <h2 className="font-display text-3xl font-semibold leading-tight tracking-tight text-ink">
            Not a summary.<br />A faithful reading.
          </h2>
          <div className="space-y-4 font-read text-lg leading-relaxed text-muted">
            <p>
              Most tools compress a video into a few bullet points. Verbatim does the opposite: it
              rewrites the spoken words into real prose, keeps the video’s exact order, and captures
              every substantive point — definitions, examples, numbers, the back-and-forth of a
              conversation.
            </p>
            <p>
              For interviews and podcasts, it attributes each point to who said it. For talks and
              tutorials, it follows the speaker’s own structure section by section. Longer video,
              longer read — the page count grows with the runtime.
            </p>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-hairline py-16 text-center md:py-24">
        <h2 className="mx-auto max-w-2xl font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Turn your next watch into a read.
        </h2>
        <Link
          href="/signup"
          className="mt-8 inline-flex items-center gap-2 rounded-xl bg-oxblood px-6 py-3.5 font-semibold text-paper shadow-soft transition-transform hover:-translate-y-px"
        >
          Get started — it’s free
        </Link>
      </section>

      <footer className="border-t border-hairline py-10 text-sm text-muted">
        <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <span>Verbatim — read any video.</span>
          <span className="font-mono text-xs">Not a summary — the whole video, faithfully.</span>
        </div>
      </footer>
    </main>
  );
}

function Step({
  n,
  icon,
  title,
  body,
}: {
  n: string;
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-oxblood/10 text-oxblood">
          {icon}
        </span>
        <span className="font-mono text-xs text-muted">{n}</span>
      </div>
      <h3 className="mt-3.5 font-display text-lg font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 text-[0.95rem] leading-relaxed text-muted">{body}</p>
    </div>
  );
}
