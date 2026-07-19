import React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import type { Note, NoteSection, NoteBlock } from "@/lib/types";

const OX = "#8A2B22";
const INK = "#221E16";
const MUTED = "#7a715f";

const s = StyleSheet.create({
  page: { paddingVertical: 56, paddingHorizontal: 64, backgroundColor: "#FBF8F0", color: INK },
  title: { fontFamily: "Times-Roman", fontSize: 24, fontWeight: 700, marginBottom: 6 },
  meta: { fontFamily: "Helvetica", fontSize: 9, color: MUTED, marginBottom: 2, textTransform: "uppercase", letterSpacing: 1 },
  link: { fontFamily: "Helvetica", fontSize: 9, color: OX, marginBottom: 18 },
  h2: { fontFamily: "Times-Roman", fontSize: 14, fontWeight: 700, marginTop: 16, marginBottom: 6 },
  h2ts: { fontFamily: "Courier", fontSize: 8, color: MUTED },
  para: { fontFamily: "Times-Roman", fontSize: 11, lineHeight: 1.55, marginBottom: 7 },
  bulletRow: { flexDirection: "row", marginBottom: 4, paddingLeft: 6 },
  bulletDot: { fontFamily: "Times-Roman", fontSize: 11, color: OX, marginRight: 6 },
  bulletText: { fontFamily: "Times-Roman", fontSize: 11, lineHeight: 1.5, flex: 1 },
  quote: { borderLeftWidth: 2, borderLeftColor: OX, paddingLeft: 10, marginVertical: 7 },
  quoteText: { fontFamily: "Times-Italic", fontSize: 11, lineHeight: 1.5, color: "#4c4536" },
  speaker: { fontFamily: "Times-Bold", color: OX },
  ts: { fontFamily: "Courier", fontSize: 8, color: MUTED },
  footer: {
    position: "absolute", bottom: 28, left: 64, right: 64,
    flexDirection: "row", justifyContent: "space-between",
    fontFamily: "Helvetica", fontSize: 8, color: MUTED,
  },
});

function inline(b: NoteBlock) {
  return (
    <>
      {b.speaker ? <Text style={s.speaker}>{b.speaker}: </Text> : null}
      <Text>{b.text}</Text>
      {b.timestamp ? <Text style={s.ts}>{"  [" + b.timestamp + "]"}</Text> : null}
    </>
  );
}

function Block({ b }: { b: NoteBlock }) {
  if (b.type === "bullet") {
    return (
      <View style={s.bulletRow}>
        <Text style={s.bulletDot}>•</Text>
        <Text style={s.bulletText}>{inline(b)}</Text>
      </View>
    );
  }
  if (b.type === "quote") {
    return (
      <View style={s.quote}>
        <Text style={s.quoteText}>{inline(b)}</Text>
      </View>
    );
  }
  return <Text style={s.para}>{inline(b)}</Text>;
}

function NoteDoc({ note, sections }: { note: Note; sections: NoteSection[] }) {
  const meta = [
    note.channel,
    note.video_type ? (note.video_type === "dialogue" ? "Dialogue" : "Monologue") : "",
    note.speakers?.join(", ") ?? "",
  ]
    .filter(Boolean)
    .join("   ·   ");

  return (
    <Document title={note.title} author={note.channel || "Verbatim"}>
      <Page size="A4" style={s.page}>
        <Text style={s.title}>{note.title || "Untitled video"}</Text>
        {meta ? <Text style={s.meta}>{meta}</Text> : null}
        <Text style={s.link}>{note.video_url}</Text>
        {sections.map((sec) => (
          <View key={sec.id} wrap>
            <Text style={s.h2}>
              {sec.heading}
              {sec.timestamp_label ? <Text style={s.h2ts}>{"   " + sec.timestamp_label}</Text> : null}
            </Text>
            {sec.content.map((b, i) => (
              <Block key={i} b={b} />
            ))}
          </View>
        ))}
        <View style={s.footer} fixed>
          <Text>Verbatim</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

export async function toPdf(note: Note, sections: NoteSection[]): Promise<Buffer> {
  return renderToBuffer(<NoteDoc note={note} sections={sections} />);
}
