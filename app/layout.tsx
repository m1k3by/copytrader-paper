import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Copytrader Paper",
  description: "Hyperliquid copytrading, simulated",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <nav className="mx-auto flex w-full max-w-5xl gap-6 px-4 pt-4 font-mono text-xs tracking-widest text-zinc-500 sm:px-8 [&_a:hover]:text-zinc-200">
          <Link href="/">PORTFOLIO</Link>
          <Link href="/leaderboard">LEADERBOARD</Link>
        </nav>
        {children}
      </body>
    </html>
  );
}
