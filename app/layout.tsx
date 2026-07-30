import type { Metadata, Viewport } from "next";
import { Fraunces, Newsreader, Instrument_Sans, Fragment_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/nav";
import { SWRegister } from "@/components/sw-register";
import { OfflineSync } from "@/components/offline-sync";
import { createClient } from "@/lib/supabase/server";

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-fraunces",
  display: "swap",
});
const newsreader = Newsreader({
  subsets: ["latin"],
  style: ["normal", "italic"],
  weight: ["400", "500"],
  variable: "--font-newsreader",
  display: "swap",
});
const instrument = Instrument_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-instrument",
  display: "swap",
});
const fragment = Fragment_Mono({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-fragment",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Verbatim — read any video",
  description:
    "Turn any YouTube video into a faithful, structured reading note. Search a title or paste a link.",
};

export const viewport: Viewport = {
  themeColor: "#4A0E14",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <html lang="en">
      <body
        className={`${fraunces.variable} ${newsreader.variable} ${instrument.variable} ${fragment.variable} font-sans antialiased`}
      >
        <Nav />
        {children}
        <SWRegister />
        <OfflineSync />
      </body>
    </html>
  );
}
