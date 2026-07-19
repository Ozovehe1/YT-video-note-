import Link from "next/link";

export function Brand({ className = "" }: { className?: string }) {
  return (
    <Link href="/" className={`inline-flex items-center gap-2.5 ${className}`} aria-label="Verbatim home">
      <span
        className="relative inline-block h-6 w-6 rounded-[7px] bg-oxblood"
        aria-hidden
      >
        <span
          className="absolute left-[9px] top-[7px] h-0 w-0"
          style={{
            borderLeft: "6px solid rgb(var(--paper))",
            borderTop: "4px solid transparent",
            borderBottom: "4px solid transparent",
          }}
        />
      </span>
      <span className="font-display text-[1.15rem] font-semibold tracking-tight text-ink">
        Verbatim
      </span>
    </Link>
  );
}
